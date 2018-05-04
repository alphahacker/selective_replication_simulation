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
  //var serverLocation;

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
      config.serverLocation = util.getServerLocation();
      resolved();
    })
  }, function(err){
      console.log(err);
  })
  //monitoring_rw 테이블 초기화 (delete from)
  .then(function(){
    return new Promise(function(resolved, rejected){
      var users = [];
      dbPool.getConnection(function(err, conn) {
        var query_stmt = 'DELETE FROM monitoring_rw';
        conn.query(query_stmt, function(err, rows) {
          conn.release(); //MySQL connection release
          if(err) rejected("DB err!");
          resolved(users);
        })
      });
    })
  }, function(err){
      console.log(err);
  })
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
      var setUsersIntoMonitoringTable = function(i, callback){
        if(i >= users.length){
          callback();
        } else {
          //여기서 DB에서 user[i] 값으로 프렌드리스트 불러오고 그 값들을 모두 레디스에 넣는다.
          dbPool.getConnection(function(err, conn) {
            var query_stmt = 'INSERT INTO monitoring_rw VALUES("' + users[i] + '", 0, 0, 0, 0)';
            console.log("[" + i + "] " + query_stmt);
            conn.query(query_stmt, function(err, rows) {
              conn.release();
              if(err){
                rejected("DB err!");
              }
              setUsersIntoMonitoringTable(i+1, callback);
            });
          });
        }
      }
      setUsersIntoMonitoringTable(0, function(){
        resolved(users);
        setUsersIntoMonitoringTable = null;
      })
    })
  }, function(err){
      console.log(err);
  })
  /**************************************************************************/
  /*********************** friend list memory 초기화 **************************/
  /**************************************************************************/
  //각 사용자의 친구 리스트도 미리 메모리(Redis)에 올려놓는다
  //POST 리퀘스트 들어올떄마다 DB에 읽어와서 처리하면 너무 느려지니까.
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
      console.log("surrogate server [" + config.serverLocation + "] is ready, completely.");
      res.send("surrogate server [" + config.serverLocation + "] is ready, completely.");
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
  let cloudLocation;

  var promise = new Promise(function(resolved, rejected){
    if(config.serverLocation == 'newyork'){
      cloudLocation = 'Cloud_East_ReadCount';
    } else if (config.serverLocation == 'texas') {
      cloudLocation = 'Cloud_Central_ReadCount';
    } else if (config.serverLocation == 'washington') {
      cloudLocation = 'Cloud_West_ReadCount';
    } else {
      console.error("Wrong cloud location!");
    }
    resolved();
  });

  promise
  .then(function(){
    return new Promise(function(resolved, rejected){
      console.log("USER - " + req.params.userId);
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
  .then(function(friendList){
    return new Promise(function(resolved, rejected){
      var incrReadCount = function(i, callback){
        if(i >= friendList.length){
          callback();
        } else {
          dbPool.getConnection(function(err, conn) {
              var query_stmt2 = 'SELECT ' + cloudLocation + ' FROM monitoring_rw WHERE UserId = "' + friendList[i] + '"'
              console.log(query_stmt2);
              conn.query(query_stmt2, function(err, result) {
                  if(err) {
                     error_log.debug("Query Stmt = " + query_stmt);
                     error_log.debug("ERROR MSG = " + err);
                     error_log.debug();
                     rejected("DB err!");
                  }
                  conn.release();

                  let readCount;
                  if(cloudLocation == 'Cloud_East_ReadCount'){
                    readCount = result[0].Cloud_East_ReadCount;
                  } else if (cloudLocation == 'Cloud_West_ReadCount') {
                    readCount = result[0].Cloud_West_ReadCount;
                  } else if (cloudLocation == 'Cloud_Central_ReadCount') {
                    readCount = result[0].Cloud_Central_ReadCount;
                  } else {
                    console.error("Cloud Location / Read Count Error !");
                  }
                  dbPool.getConnection(function(err, conn) {
                      let newReadCount = readCount + 1;
                      let query_stmt3 = 'UPDATE monitoring_rw SET ' + cloudLocation + ' = ' + newReadCount + ' WHERE UserId = "' + friendList[i] + '"'
                      console.log(query_stmt3);
                      conn.query(query_stmt3, function(err, result) {
                          if(err) {
                             error_log.debug("Query Stmt = " + query_stmt);
                             error_log.debug("ERROR MSG = " + err);
                             error_log.debug();
                             rejected("DB err!");
                          }
                          conn.release();
                          incrReadCount(i+1, callback);
                      });
                  });
              });
          });
        }
      }
      incrReadCount(0, function(){
        resolved();
        incrReadCount = null;
      })
    })
  }, function(err){
      console.log(err);
  })
  .then(function(){
    return new Promise(function(resolved, rejected){

      // 여기서 latency delay 계산해주고,
      // Little's theorem 도 할 수 있게, 트래픽 양도 계산 해주자.
      // 혹시 모르니까 다른것도 다 넣어줄까..

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
      resolved();
    })
  }, function(err){
      console.log(err);
  })
});

router.post('/:userId', function(req, res, next) {
  var promise = new Promise(function(resolved, rejected){
    dbPool.getConnection(function(err, conn) {
        var query_stmt2 = 'SELECT WriteCount FROM monitoring_rw WHERE UserId = "' + req.params.userId + '"'
        conn.query(query_stmt2, function(err, result) {
            if(err) {
               error_log.debug("Query Stmt = " + query_stmt);
               error_log.debug("ERROR MSG = " + err);
               error_log.debug();
               rejected("DB err!");
            }
            let writeCount = result[0].WriteCount;
            conn.release();
            resolved(writeCount);
        });
    });
  });
  promise
  .then(function(writeCount){
    return new Promise(function(resolved, rejected){
      dbPool.getConnection(function(err, conn) {
          let newWriteCount = writeCount + 1;
          let query_stmt2 = 'UPDATE monitoring_rw SET WriteCount = ' + newWriteCount + ' WHERE UserId = "' + req.params.userId + '"'
          conn.query(query_stmt2, function(err, result) {
              if(err) {
                 error_log.debug("Query Stmt = " + query_stmt);
                 error_log.debug("ERROR MSG = " + err);
                 error_log.debug();
                 rejected("DB err!");
              }
              conn.release();
              resolved();
          });
      });
    })
  }, function(err){
      console.log(err);
  })
  .then(function(){
    return new Promise(function(resolved, rejected){
        res.json({
          "status" : "OK"
        })
        monitoring.thisHourWrite += 76;
        operation_log.info("[Write Operation Count]= " + ++monitoring.writeCount);
        resolved();
    })
  }, function(err){
      console.log(err);
  })
});

module.exports = router;
