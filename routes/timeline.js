var express = require('express');
var router = express.Router();
var bodyParser = require('body-parser');
var redis = require('redis');
var JSON = require('JSON');

var log4js = require('log4js');
log4js.configure('./configure/log4js.json');
var operation_log = log4js.getLogger("operation");
var error_log = log4js.getLogger("error");
var interim_log = log4js.getLogger("interim");

var dbPool = require('../src/db.js');
var redisPool = require('../src/caching.js');
var redirect = require('../src/redirector_send.js');
var memoryManager = require('../src/memoryManager.js');
var util = require('../src/util.js');
var config = require('../src/configs.js');
var monitoring = require('../src/monitoring.js');
var coord = require('../src/coord.js');
var job = require('../src/periodicTask.js')

var app = express();

//---------------------------------------------------------------------------//

router.get('/init', function(req, res, next) {

  /* db 에서 각 사용자에게 할당된 메모리 양 가지고 오기 */
  var MAX_MEMORY = config.totalMemory;
  var serverLocation;

  var allUsersContents = [];
  var userLocations = [];

  var current_hour; //현재 시각
  var usage_sum;
  var usersMemory = [];

  var promise = new Promise(function(resolved, rejected){
    resolved();
  });

  promise
  .then(function(result){
    return new Promise(function(resolved, rejected){
      //이때 현재 서버의 IP에 따라 어떤 테이블의 내용을 넣을지 결정해야한다.
      //예를들어, newyork에 있는 서버라면, newyork 테이블의 내용을 가져와야함.
      serverLocation = util.getServerLocation();
      resolved();
    })
  }, function(err){
      console.log(err);
  })

  /**************************************************************************/
  /************************** social memory 초기화 ****************************/
  /**************************************************************************/

  //현재 시각 불러오기
  .then(function(){
    return new Promise(function(resolved, rejected){
      var NT_date = new Date();
      current_hour = NT_date.getHours();  //현재 시각
      resolved();
    })
  }, function(err){
      console.log(err);
  })

  //다음 시간에 모든 사용자 사용량의 합 구하기
  .then(function(){
    return new Promise(function(resolved, rejected){
      dbPool.getConnection(function(err, conn) {
          var next_hour = 0;
          if(current_hour == 23){
            next_hour = 0;
          }
          else {
            next_hour = current_hour + 1; // 다음 시간의 사용량을 보고, 미리 캐싱하는 것이므로
          }

          var query_stmt = 'SELECT SUM(B.' + next_hour + 'h) AS usage_sum ' +
                           'FROM ' + serverLocation + ' A JOIN user_usage B ' +
                           'ON A.userId = B.userId';
          console.log(query_stmt);
          conn.query(query_stmt, function(err, rows) {
              if(err) {
                 rejected("DB err!");
              }
              if(rows.length != 0){
                usage_sum = rows[0].usage_sum;
                conn.release(); //MySQL connection release
                resolved();
              } else {
                console.log("rows.length == 0")
              }
          })
      });
    })
  }, function(err){
      console.log(err);
  })

  //다음 시간에 각 사용자의 사용량 리스트 구하기
  .then(function(){
    return new Promise(function(resolved, rejected){
      dbPool.getConnection(function(err, conn) {
          var next_hour = 0;
          if(current_hour == 23){
            next_hour = 0;
          }
          else {
            next_hour = current_hour + 1; // 다음 시간의 사용량을 보고, 미리 캐싱하는 것이므로
          }
          //var next_hour = current_hour + 1; // 다음 시간의 사용량을 보고, 미리 캐싱하는 것이므로
          var query_stmt = 'SELECT A.userId, B.' + next_hour + 'h as eachUsage' + ' ' +
                           'FROM ' + serverLocation + ' A JOIN user_usage B ' +
                           'ON A.userId = B.userId';
          console.log(query_stmt);
          conn.query(query_stmt, function(err, rows) {
              if(err) {
                 rejected("DB err!");
              }
              for (var i=0; i<rows.length; i++) {
                var portion =  rows[i].eachUsage / usage_sum;
                var userMemory = MAX_MEMORY * portion;
                //console.log("USER ID = " + rows[i].userId + ", PORTION = " + portion + ", MEMORY SIZE = " + userMemory);

                usersMemory.push({
                    userId : rows[i].userId,
                    userPortion : portion,
                    userMemory : userMemory
                });
              }
              conn.release(); //MySQL connection release
              resolved();
          })
      });
    })
  }, function(err){
      console.log(err);
  })

  //Redis에 각 사용자 메모리 사이즈 Set
  .then(function(){
    return new Promise(function(resolved, rejected){
      var setSocialMemoryInRedis = function(i, callback){
        if(i >= usersMemory.length){
          callback();
        } else {
          //key는 사용자 ID 이고, value는 전체 메모리 양 * portion
          var key = usersMemory[i].userId;
          var value = usersMemory[i].userMemory;
          redisPool.socialMemory.set(key, value, function (err) {
              if(err) rejected("fail to initialize the social memory in Redis");
              console.log("["+ i +"] key : " + key + ", value : " + value);
              setSocialMemoryInRedis(i+1, callback);
          });
        }
      }

      setSocialMemoryInRedis(0, function(){
        resolved();
        setSocialMemoryInRedis = null;
      })
    })
  }, function(err){
      console.log(err);
  })

  /**************************************************************************/
  /************************** index memory 초기화 *****************************/
  /**************************************************************************/
  //그동안 사용자가 POST 리퀘스트를 통해 저장해놨던 데이터에 대한 Index를 다시 Redis에 올린다
  //(사용자 데이터는 [1] Index와  [2] 각 Index와 매칭되는 데이터로 구성되어 있다.)
  //(Index 내용과 Data는 기본적으로 DB에도 저장된다.)
  .then(function(){
    return new Promise(function(resolved, rejected){
      var getUsersContentsFromDB = function(i, callback){
        var userContents = {};

        if(i >= usersMemory.length){
          callback();

        } else {
          dbPool.getConnection(function(err, conn) {
            var userId = usersMemory[i].userId;
            userContents.userId = userId;

            var contentIdList = [];
            var query_stmt = 'SELECT A.contentId FROM timeline A ' +
                             'JOIN user B ' +
                             'ON A.uid = B.id ' +
                             'WHERE B.userId = "' + userId + '"';
            conn.query(query_stmt, function(err, rows) {
              if(err) rejected("DB err!");

              for (var j=0; j<rows.length; j++) {
                  contentIdList.push(rows[j].contentId);
              }

              if(rows.length != 0) {
                userContents.contentIdList = contentIdList;
                allUsersContents.push(userContents);
              }

              getUsersContentsFromDB(i+1, callback);
              conn.release(); //MySQL connection release
            })
          });
        }
      }

      getUsersContentsFromDB(0, function(){
        resolved();
        getUsersContentsFromDB = null;
      })

    })
  }, function(err){
      console.log(err);
  })
  .then(function(){
    return new Promise(function(resolved, rejected){
      var setIndexMemoryInRedis = function(i, callback){
        if(i >= allUsersContents.length){
          callback();
        } else {
          var key = allUsersContents[i].userId;
          var contentList = allUsersContents[i].contentIdList;

          for(var j=0; j<contentList.length; j++){
            var setContentList = function(contentIndex){
              var value = contentList[contentIndex];
              redisPool.indexMemory.lpush(key,value, function (err) {
                  if(err) rejected("fail to set the index memory in Redis");
              });
            }(j);
          }
          setIndexMemoryInRedis(i+1, callback);
        }
      }

      setIndexMemoryInRedis(0, function(){
        resolved();
        setIndexMemoryInRedis = null;
      })
    })
  }, function(err){
      console.log(err);
  })
  .then(function(){
    return new Promise(function(resolved, rejected){
      console.log("index memory ready");
      resolved();
    })
  }, function(err){
      console.log(err);
  })



  /**************************************************************************/
  /*********************** friend list memory 초기화 **************************/
  /**************************************************************************/
  //각 사용자의 친구 리스트도 미리 메모리(Redis)에 올려놓는다
  //POST 리퀘스트 들어올떄마다 DB에 읽어와서 처리하면 너무 느려지니까.
  .then(function(){
    return new Promise(function(resolved, rejected){
      var users = [];
      dbPool.getConnection(function(err, conn) {
        var query_stmt = 'SELECT userId FROM user';
        conn.query(query_stmt, function(err, rows) {
          conn.release(); //MySQL connection release

          if(err) rejected("DB err!");

          for (var j=0; j<rows.length; j++) {
              users.push(rows[j].userId);
          }
          resolved(users);
        })
      });
    })
  }, function(err){
      console.log(err);
  })
  .then(function(users){
    return new Promise(function(resolved, rejected){
      var setUserFriendsInRedis = function(i, callback){
        if(i >= users.length){
          callback();
        } else {
          //여기서 DB에서 user[i] 값으로 프렌드리스트 불러오고 그 값들을 모두 레디스에 넣는다.
          dbPool.getConnection(function(err, conn) {
            var query_stmt = 'SELECT friendId FROM friendList WHERE userId = "' + users[i] + '"';
            conn.query(query_stmt, function(err, rows) {
              conn.release();
              if(err){
                rejected("DB err!");
              }
              else {
                var key = users[i];
                var friendList = rows;
                for(var j=0; j<friendList.length; j++){
                  var setContentList = function(friendIndex){
                    var value = friendList[friendIndex].friendId;
                    // if(key == 'AgProud'){
                    // console.log("[set friend list] User ID = " + key + ", Friend ID = " + value);
                    // }
                    redisPool.friendListMemory.lpush(key, value, function (err) {
                        if(err) rejected("fail to set the friend list memory in Redis");
                    });
                  }(j);
                }
                setUserFriendsInRedis(i+1, callback);
              }
            });
          });
        }
      }

      setUserFriendsInRedis(0, function(){
        resolved();
        setUserFriendsInRedis = null;
      })
    })
  }, function(err){
      console.log(err);
  })
  .then(function(){
    return new Promise(function(resolved, rejected){
      console.log("friend list memory ready");
      resolved();
    })
  }, function(err){
      console.log(err);
  })



  /**************************************************************************/
  /************************** User Location 초기화 ****************************/
  /**************************************************************************/
  .then(function(){
    return new Promise(function(resolved, rejected){
      dbPool.getConnection(function(err, conn) {
          var query_stmt = 'SELECT userId, userLocation FROM user';
          conn.query(query_stmt, function(err, rows) {
              if(err) {
                 rejected("DB err!");
              }
              for (var i=0; i<rows.length; i++) {
                  userLocations.push({
                      userId : rows[i].userId,
                      userLocation : rows[i].userLocation
                  });
              }
              conn.release(); //MySQL connection release
              resolved();
          })
      });
    })
  }, function(err){
      console.log(err);
  })
  .then(function(){
    return new Promise(function(resolved, rejected){
      var setUserLocationInRedis = function(i, callback){
        if(i >= userLocations.length){
          callback();
        } else {
          var key = userLocations[i].userId;
          var value = userLocations[i].userLocation;
          redisPool.locationMemory.set(key, value, function (err) {
              if(err) rejected("fail to initialize user location memory in Redis");
              //console.log("["+ i +"] key : " + key + ", value : " + value);
              setUserLocationInRedis(i+1, callback);
          });
        }
      }

      setUserLocationInRedis(0, function(){
        resolved();
        setUserLocationInRedis = null;
      })
    })
  }, function(err){
      console.log(err);
  })
  .then(function(){
    return new Promise(function(resolved, rejected){
      console.log("user location memory ready");
      resolved();
    })
  }, function(err){
      console.log(err);
  })

  /**************************************************************************/
  /************************** coord information *****************************/
  /**************************************************************************/

  .then(function(){
    return new Promise(function(resolved, rejected){
      dbPool.getConnection(function(err, conn) {
          var query_stmt = 'SELECT * FROM coord';
          conn.query(query_stmt, function(err, rows) {
              if(err) {
                 rejected("DB err!");
              }
              for (var i=0; i<rows.length; i++) {
                  coord[rows[i].location] = {
                    lat : rows[i].lat,
                    lng : rows[i].lng
                  };
              }
              conn.release(); //MySQL connection release
              resolved();
          })
      });
    })
  }, function(err){
      console.log(err);
  })
  .then(function(){
    return new Promise(function(resolved, rejected){
      console.log("coord information ready");
      resolved();
    })
  }, function(err){
      console.log(err);
  })
  .then(function(){
    return new Promise(function(resolved, rejected){
      job.setUserContents();
      resolved();
    })
  }, function(err){
      console.log(err);
  })
  .then(function(){
    return new Promise(function(resolved, rejected){
      console.log("surrogate server [" + serverLocation + "] is ready, completely.");
      res.send("surrogate server [" + serverLocation + "] is ready, completely.");
      resolved();
    })
  }, function(err){
      console.log(err);
  })
});

//Get each user's timeline contents
router.get('/userId/:userId/numAccess/:numAccess', function(req, res, next) {
  //key는 사용자 ID
  //var key = req.params.userId;
  var userLocation;

  //index memory에 있는 contents list를 저장
  var contentIndexList = [];
  var contentDataList = [];
  var tweetObject = {};

  var promise = new Promise(function(resolved, rejected){
    resolved();
  });

  promise
  .then(function(contentIndexList){
    return new Promise(function(resolved, rejected){
      var friendList = [];
      var key = req.params.userId;
      var start = 0;
      var end = -1;
      redisPool.friendListMemory.lrange(key, start, end, function (err, result) {
          if(err){
            error_log.info("fail to get the index memory in Redis : " + err);
            error_log.info("key (req.params.userId) : " + key + ", start : " + start + ", end : " + end);
            error_log.info();
            rejected("fail to get the index memory in Redis");
          }
          friendList = result;
          resolved(friendList);
      });
    })
  }, function(err){
      console.log(err);
  })
  .then(function(){
    return new Promise(function(resolved, rejected){
      var key = req.params.userId;
      redisPool.locationMemory.get(key, function (err, result) {
          if(err){
            error_log.info("fail to get user location from redis! : " + err);
            error_log.info("key (req.params.userId) : " + key);
            error_log.info();
            rejected("fail to get user location from redis! ");
          }
          if(result){
            userLocation = result;
            resolved(contentIndexList);
          } else {
            dbPool.getConnection(function(err, conn) {
              var query_stmt = 'SELECT userLocation FROM user ' +
                               'WHERE userId = "' + key + '"';
              conn.query(query_stmt, function(err, result) {
                  if(err){
                    error_log.info("fail to get user location from MySQL! : " + err);
                    error_log.info("key (userId) : " + key + "\ㅜn");

                    conn.release(); //MySQL connection release
                    rejected("fail to get user location from MySQL!");
                  }
                  else if(result == undefined || result == null){
                    error_log.info("fail to get user location from MySQL! : There is no result.");
                    error_log.info("key (userId) : " + key + "\ㅜn");

                    conn.release(); //MySQL connection release
                    rejected("fail to get user location from MySQL!");
                  } else {
                    userLocation = result[0].userLocation;
                    resolved(contentIndexList);
                    conn.release(); //MySQL connection release
                  }
              })
            });
          }
      });
    })
  }, function(err){
      console.log(err);
  })
  .then(function(){
    return new Promise(function(resolved, rejected){

      var readStartTime = 0;
      var readEndTime = 0;
      readStartTime = new Date().getTime();
      readEndTime = new Date().getTime();

      operation_log.info("[Read Execution Delay]= " + (readEndTime - readStartTime) + "ms");
      operation_log.info("[Read Operation Count]= " + ++monitoring.readCount);
      operation_log.info("[Cache Hit]= " + monitoring.cacheHit + ", [Cache Miss]= " + monitoring.cacheMiss + ", [Cache Ratio]= " + monitoring.getCacheHitRatio() + "\n");
      resolved();
    })
  }, function(err){
      console.log(err);
  })
  .then(function(){
    return new Promise(function(resolved, rejected){
      res.json({
        status : "OK"
      });
    })
  }, function(err){
      console.log(err);
  })
});

router.post('/:userId', function(req, res, next) {
  var promise = new Promise(function(resolved, rejected){
    dbPool.getConnection(function(err, conn) {
        var query_stmt2 = 'INSERT INTO content (uid, message) VALUES (' + userPkId + ', "' + req.body.contentData + '")'
        conn.query(query_stmt2, function(err, result) {
            if(err) {
               error_log.debug("Query Stmt = " + query_stmt);
               error_log.debug("ERROR MSG = " + err);
               error_log.debug();
               rejected("DB err!");
            }
            else {
            }
            conn.release();
        });
    });
  });
  promise
  .then(function(){
    return new Promise(function(resolved, rejected){
        res.json({
          "status" : "OK"
        })
        monitoring.thisHourWrite += 76;
        operation_log.info("[Write Operation Count]= " + ++monitoring.writeCount);
    })
  }, function(err){
      console.log(err);
  })
});

module.exports = router;
