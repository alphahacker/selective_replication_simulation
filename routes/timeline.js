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
//var job = require('../src/periodicTask.js')

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

  /* Read 할때 Cache hit 측정해줘야 한다. */

  //기본 read 개수
  // var numReadContents = 1;
  // var numReadContents = 10;
  var numReadContents = 100;

  //key는 사용자 ID
  //var key = req.params.userId;
  var userLocation;

  var start = 0;
  var end = req.params.numAccess * numReadContents;

  //index memory에 있는 contents list를 저장
  var contentIndexList = [];
  var contentDataList = [];
  var tweetObject = {};

  var promise = new Promise(function(resolved, rejected){
    resolved(contentIndexList);
  });

  promise
  .then(function(contentIndexList){
    return new Promise(function(resolved, rejected){
      var key = req.params.userId;
      redisPool.indexMemory.lrange(key, start, end, function (err, result) {
          if(err){
            error_log.info("fail to get the index memory in Redis : " + err);
            error_log.info("key (req.params.userId) : " + key + ", start : " + start + ", end : " + end);
            error_log.info();
            rejected("fail to get the index memory in Redis");
          }
          contentIndexList = result;
          //console.log(contentIndexList);
          resolved(contentIndexList);
      });
    })
  }, function(err){
      console.log(err);
  })
  .then(function(contentIndexList){
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

  .then(function(contentIndexList){
    return new Promise(function(resolved, rejected){

      var readStartTime = 0;
      var readEndTime = 0;

      readStartTime = new Date().getTime();
      var getUserContentData = function(i, callback){
        if(i >= contentIndexList.length){
          callback();
        } else {
          var key = contentIndexList[i];
          redisPool.dataMemory.get(key, function (err, result) {
              if(err){
                error_log.info("fail to push the content from data memory in redis! : " + err );
                error_log.info("key (contentIndexList[" + i + "] = " + contentIndexList[i] + ") : " + key);
                error_log.info();
                rejected("fail to push the content from data memory in redis! ");
              }
              if(result){
                contentDataList.push(result);
                //console.log("cache hit!");
                monitoring.cacheHit++;
                getUserContentData(i+1, callback);

              } else {
                dbPool.getConnection(function(err, conn) {
                  var query_stmt = 'SELECT message FROM content ' +
                                   'WHERE id = ' + key;
                  conn.query(query_stmt, function(err, result) {
                      if(err){
                        error_log.info("fail to get message (MySQL) : " + err);
                        error_log.info("QUERY STMT : " + query_stmt);
                        error_log.info();
                        rejected("DB err!");
                      }
                      if(result){
                        tweetObject.userId = req.params.userId;
                        tweetObject.contentId = contentIndexList[i];
                        tweetObject.content = result[0].message;

                        memoryManager.checkMemory(tweetObject);

                        contentDataList.push(result[0].message);
                        //console.log("cache miss!");

                        monitoring.cacheMiss++;
                        //interim_log.info("[Cache Miss] USER ID = " + req.params.userId + ", CONTENT ID = " + key  + ", START INDEX = " + start + ", END INDEX = " + end + ", MISS INDEX = " + i);

                      } else {
                        error_log.error("There's no data, even in the origin mysql server!");
                        error_log.error();
                      }

                      conn.release(); //MySQL connection release
                      getUserContentData(i+1, callback);
                  })
              });
            }
          });
        }
      }

      getUserContentData(0, function(){
        readEndTime = new Date().getTime();

        operation_log.info("[Read Execution Delay]= " + (readEndTime - readStartTime) + "ms");
        //operation_log.info("[Read Latency Delay]= " + monitoring.getLatencyDelay(util.getServerLocation(), userLocation) + "ms");

        monitoring.thisHourRead += req.params.numAccess * numReadContents * 76;

        operation_log.info("[Read Operation Count]= " + ++monitoring.readCount);
        //operation_log.info("[Read Operation Count]= " + ++monitoring.readCount + ", [This Hour Traffic Til Now] = " + monitoring.thisHour);
        operation_log.info("[Cache Hit]= " + monitoring.cacheHit + ", [Cache Miss]= " + monitoring.cacheMiss + ", [Cache Ratio]= " + monitoring.getCacheHitRatio() + "\n");
        resolved();
        getUserContentData = null;
      })
    })
  }, function(err){
      console.log(err);
  })

  .then(function(){
    return new Promise(function(resolved, rejected){
      res.json({
        status : "OK",
        contents : contentDataList
      });
    })
  }, function(err){
      console.log(err);
  })
});

// //Get each user's timeline contents
// router.get('/userId/:userId/numAccess/:numAccess', function(req, res, next) {
//
//   /* Read 할때 Cache hit 측정해줘야 한다. */
//
//   //기본 read 개수
//   var numReadContents = 10;
//
//   //key는 사용자 ID
//   //var key = req.params.userId;
//   var userLocation;
//
//   var start = 0;
//   var end = req.params.numAccess * numReadContents;
//
//   //index memory에 있는 contents list를 저장
//   var contentIndexList = [];
//   var contentDataList = [];
//
//   var promise = new Promise(function(resolved, rejected){
//     resolved(contentIndexList);
//   });
//
//   promise
//   .then(function(contentIndexList){
//     return new Promise(function(resolved, rejected){
//       var key = req.params.userId;
//       // console.log("key (userId) = " + key);
//       // console.log("lrange start index = " + start);
//       // console.log("lrange end index = " + end);
//       redisPool.indexMemory.lrange(key, start, end, function (err, result) {
//           if(err){
//             error_log.info("fail to get the index memory in Redis : " + err);
//             error_log.info("key (req.params.userId) : " + key + ", start : " + start + ", end : " + end);
//             error_log.info();
//             rejected("fail to get the index memory in Redis");
//           }
//           contentIndexList = result;
//           //console.log(contentIndexList);
//           resolved(contentIndexList);
//       });
//     })
//   }, function(err){
//       console.log(err);
//   })
//   .then(function(contentIndexList){
//     return new Promise(function(resolved, rejected){
//       var key = req.params.userId;
//       redisPool.locationMemory.get(key, function (err, result) {
//           if(err){
//             error_log.info("fail to get user location from redis! : " + err);
//             error_log.info("key (req.params.userId) : " + key);
//             error_log.info();
//             rejected("fail to get user location from redis! ");
//           }
//           if(result){
//             userLocation = result;
//             resolved(contentIndexList);
//           } else {
//             dbPool.getConnection(function(err, conn) {
//               var query_stmt = 'SELECT userLocation FROM user ' +
//                                'WHERE userId = "' + key + '"';
//               conn.query(query_stmt, function(err, result) {
//                   if(err){
//                     error_log.info("fail to get user location from MySQL! : " + err);
//                     error_log.info("key (userId) : " + key + "\ㅜn");
//
//                     conn.release(); //MySQL connection release
//                     rejected("fail to get user location from MySQL!");
//                   }
//                   else if(result == undefined || result == null){
//                     error_log.info("fail to get user location from MySQL! : There is no result.");
//                     error_log.info("key (userId) : " + key + "\ㅜn");
//
//                     conn.release(); //MySQL connection release
//                     rejected("fail to get user location from MySQL!");
//                   } else {
//                     userLocation = result[0].userLocation;
//                     resolved(contentIndexList);
//                     conn.release(); //MySQL connection release
//                   }
//               })
//             });
//           }
//       });
//     })
//   }, function(err){
//       console.log(err);
//   })
//
//   .then(function(contentIndexList){
//     return new Promise(function(resolved, rejected){
//
//       var readStartTime = 0;
//       var readEndTime = 0;
//
//       readStartTime = new Date().getTime();
//       var getUserContentData = function(i, callback){
//         if(i >= contentIndexList.length){
//           callback();
//         } else {
//           var key = contentIndexList[i];
//           redisPool.dataMemory.get(key, function (err, result) {
//               if(err){
//                 error_log.info("fail to push the content from data memory in redis! : " + err );
//                 error_log.info("key (contentIndexList[" + i + "] = " + contentIndexList[i] + ") : " + key);
//                 error_log.info();
//                 rejected("fail to push the content from data memory in redis! ");
//               }
//               if(result){
//                 contentDataList.push(result);
//                 //console.log("cache hit!");
//                 monitoring.cacheHit++;
//                 getUserContentData(i+1, callback);
//
//               } else {
//                 dbPool.getConnection(function(err, conn) {
//                   var query_stmt = 'SELECT message FROM content ' +
//                                    'WHERE id = ' + key;
//                   conn.query(query_stmt, function(err, result) {
//                       if(err){
//                         error_log.info("fail to get message (MySQL) : " + err);
//                         error_log.info("QUERY STMT : " + query_stmt);
//                         error_log.info();
//                         rejected("DB err!");
//                       }
//                       if(result){
//                         contentDataList.push(result[0].message);
//                         //console.log("cache miss!");
//                         monitoring.cacheMiss++;
//                         interim_log.info("[Cache Miss] USER ID = " + req.params.userId + ", CONTENT ID = " + key  + ", START INDEX = " + start + ", END INDEX = " + end + ", MISS INDEX = " + i);
//
//                       } else {
//                         error_log.error("There's no data, even in the origin mysql server!");
//                         error_log.error();
//                       }
//
//                       conn.release(); //MySQL connection release
//                       getUserContentData(i+1, callback);
//                   })
//               });
//             }
//           });
//         }
//       }
//
//       getUserContentData(0, function(){
//         readEndTime = new Date().getTime();
//         operation_log.info("[Read Execution Delay]= " + (readEndTime - readStartTime) + "ms");
//         //operation_log.info("[Read Latency Delay]= " + monitoring.getLatencyDelay(util.getServerLocation(), userLocation) + "ms");
//         operation_log.info("[Read Operation Count]= " + ++monitoring.readCount);
//         operation_log.info("[Cache Hit]= " + monitoring.cacheHit + ", [Cache Miss]= " + monitoring.cacheMiss + ", [Cache Ratio]= " + monitoring.getCacheHitRatio() + "\n");
//         resolved();
//         getUserContentData = null;
//       })
//     })
//   }, function(err){
//       console.log(err);
//   })
//
//   .then(function(){
//     return new Promise(function(resolved, rejected){
//       res.json({
//         status : "OK",
//         contents : contentDataList
//       });
//     })
//   }, function(err){
//       console.log(err);
//   })
// });

//Get each user's timeline contents
router.get('/:userId', function(req, res, next) {

  /* Read 할때 Cache hit 측정해줘야 한다. */

  //key는 사용자 ID
  //var key = req.params.userId;
  var userLocation;

  //사용자의 친구 수 만큼 컨텐츠를 읽어오도록 한다. (친구 수와 사용량이 비례하기 때문에, 친구 수가 많은 사용자가 더 많은 컨텐츠를 한번에 읽어 올거라고 생각해서)
  var start = 0;
  var end = 0;

  //index memory에 있는 contents list를 저장
  var contentIndexList = [];
  var contentDataList = [];

  var promise = new Promise(function(resolved, rejected){
    var key = req.params.userId;
    redisPool.friendListMemory.llen(key, function (err, result) {
        if(err){
          error_log.info("fail to get the friendList memory in Redis : " + err);
          error_log.info("key (req.params.userId) : " + key);
          error_log.info();
          rejected("fail to get the friendList memory in Redis");
        }
        else if(result == undefined || result == null){
          error_log.info("fail to get the friendList memory in Redis : " + err);
          error_log.info("key (req.params.userId) : " + key);
          error_log.info();
          console.log("There's no data in friendListMemory!");
          rejected("fail to get the friendList memory in Redis");
        }
        else {
          end = result;
          resolved(contentIndexList);
        }
    });
  });

  promise
  .then(function(contentIndexList){
    return new Promise(function(resolved, rejected){
      var key = req.params.userId;
      // console.log("key (userId) = " + key);
      // console.log("lrange start index = " + start);
      // console.log("lragne end index = " + end);
      redisPool.indexMemory.lrange(key, start, end, function (err, result) {
          if(err){
            error_log.info("fail to get the index memory in Redis : " + err);
            error_log.info("key (req.params.userId) : " + key + ", start : " + start + ", end : " + end);
            error_log.info();
            rejected("fail to get the index memory in Redis");
          }
          contentIndexList = result;
          resolved(contentIndexList);
      });
    })
  }, function(err){
      console.log(err);
  })
  .then(function(contentIndexList){
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
                               'WHERE userId = ' + key;
              conn.query(query_stmt, function(err, result) {
                  if(err){
                    error_log.info("fail to get user location from MySQL! : " + err);
                    error_log.info("key (userId) : " + key + "\ㅜn");

                    conn.release(); //MySQL connection release
                    rejected("fail to get user location from MySQL!");
                  }
                  if(result == undefined || result == null){
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

  .then(function(contentIndexList){
    return new Promise(function(resolved, rejected){

      var readStartTime = 0;
      var readEndTime = 0;

      readStartTime = new Date().getTime();
      var getUserContentData = function(i, callback){
        if(i >= contentIndexList.length){
          callback();
        } else {
          var key = contentIndexList[i];
          redisPool.dataMemory.get(key, function (err, result) {
              if(err){
                error_log.info("fail to push the content from data memory in redis! : " + err );
                error_log.info("key (contentIndexList[" + i + "] = " + contentIndexList[i] + ") : " + key);
                error_log.info();
                rejected("fail to push the content from data memory in redis! ");
              }
              if(result){
                contentDataList.push(result);
                //console.log("cache hit!");
                monitoring.cacheHit++;
                getUserContentData(i+1, callback);

              } else {
                dbPool.getConnection(function(err, conn) {
                  var query_stmt = 'SELECT message FROM content ' +
                                   'WHERE id = ' + key;
                  conn.query(query_stmt, function(err, result) {
                      if(err){
                        error_log.info("fail to get message (MySQL) : " + err);
                        error_log.info("QUERY STMT : " + query_stmt);
                        error_log.info();
                        rejected("DB err!");
                      }
                      if(result){
                        contentDataList.push(result[0].message);
                        //console.log("cache miss!");
                        monitoring.cacheMiss++;
                        interim_log.info("[Cache Miss] USER ID = " + req.params.userId + ", CONTENT ID = " + key  + ", START INDEX = " + start + ", END INDEX = " + end + ", MISS INDEX = " + i);

                      } else {
                        error_log.error("There's no data, even in the origin mysql server!");
                        error_log.error();
                      }

                      conn.release(); //MySQL connection release
                      getUserContentData(i+1, callback);
                  })
              });
            }
          });
        }
      }

      getUserContentData(0, function(){
        readEndTime = new Date().getTime();
        operation_log.info("[Read Execution Delay]= " + (readEndTime - readStartTime) + "ms");
        //operation_log.info("[Read Latency Delay]= " + monitoring.getLatencyDelay(util.getServerLocation(), userLocation) + "ms");
        operation_log.info("[Read Operation Count]= " + ++monitoring.readCount);
        operation_log.info("[Cache Hit]= " + monitoring.cacheHit + ", [Cache Miss]= " + monitoring.cacheMiss + ", [Cache Ratio]= " + monitoring.getCacheHitRatio() + "\n");
        resolved();
        getUserContentData = null;
      })
    })
  }, function(err){
      console.log(err);
  })

  .then(function(){
    return new Promise(function(resolved, rejected){
      res.json({
        status : "OK",
        contents : contentDataList
      });
    })
  }, function(err){
      console.log(err);
  })
});

//Post a content to users' timelines
router.post('/:userId', function(req, res, next) {

  var tweetObjectList = [];

  //console.log("data length = " + req.body.contentData.length);

  //2. 친구들 리스트 뽑아서
  var promise = new Promise(function(resolved, rejected){
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
  });

  //3-1. origin server에 있는 mysql의 content에 모든 친구들에 대해서 데이터를 넣는다. 이 때, lastInsertId를 이용해서 contentId를 만듦.
  promise
  .then(function(friendList){
    return new Promise(function(resolved, rejected){
      var pushTweetInOriginDB = function(i, callback){
        // console.log("userId = " + req.params.userId);
        // console.log("friendList.length = " + friendList.length);
        if(i >= friendList.length){
          callback();
        } else {
          dbPool.getConnection(function(err, conn) {
              var query_stmt = 'SELECT id FROM user WHERE userId = "' + friendList[i] + '"';
              //console.log(query_stmt);
              conn.query(query_stmt, function(err, result) {
                  if(err) {
                     error_log.debug("Query Stmt = " + query_stmt);
                     error_log.debug("ERROR MSG = " + err);
                     error_log.debug();
                     rejected("DB err!");
                  }
                  var userPkId = result[0].id;
                  conn.release(); //MySQL connection release

                  //////////////////////////////////////////////////////////////
                  dbPool.getConnection(function(err, conn) {
                      var query_stmt2 = 'INSERT INTO content (uid, message) VALUES (' + userPkId + ', "' + req.body.contentData + '")'
                      conn.query(query_stmt2, function(err, result) {
                          if(err) {
                             error_log.debug("Query Stmt = " + query_stmt);
                             error_log.debug("ERROR MSG = " + err);
                             error_log.debug();
                             rejected("DB err!");
                          }
                          if(result == undefined || result == null){
                              error_log.debug("Query Stmt = " + query_stmt2);
                              error_log.debug("Query Result = " + result);
                          }
                          else {
                            var tweetObject = {};
                            tweetObject.userId = friendList[i];
                            tweetObject.contentId = Number(result.insertId);
                            tweetObject.content = req.body.contentData;
                            tweetObjectList.push(tweetObject);
                          }
                          conn.release();
                          pushTweetInOriginDB(i+1, callback);
                      });
                  });
                  //////////////////////////////////////////////////////////////
              });
          });
        }
      }

      pushTweetInOriginDB(0, function(){
        resolved();
        pushTweetInOriginDB = null;
      })
    })
  }, function(err){
      console.log(err);
  })

  //4. 다른 surrogate 서버로 redirect
  .then(function(){
    return new Promise(function(resolved, rejected){
      try {
        if(tweetObjectList.length > 0){
          redirect.send(tweetObjectList);
        }
        resolved();

      } catch (e) {
        error_log.debug("Redirect Error = " + e);
        error_log.debug();
        rejected("Redirect error : " + e);
      }
    })
  }, function(err){
      console.log(err);
  })
  //5. tweetObjectList를 이용해서, 각 surrogate 서버 index 메모리에, 모든 친구들에 대해서 넣는다.
  .then(function(){
    return new Promise(function(resolved, rejected){
      var pushTweetInIndexMemory = function(i, callback){
        if(i >= tweetObjectList.length){
          callback();
        } else {
          var key = tweetObjectList[i].userId;
          var value = tweetObjectList[i].contentId;
          redisPool.indexMemory.rpush(key, value, function (err) {
              if(err){
                error_log.debug("fail to push the content into friend's index memory in Redis : " + err);
                error_log.debug("key (tweetObjectList[i].userId) : " + key + ", value (tweetObjectList[i].contentId) : " + value);
                error_log.debug();
                rejected("fail to push the content into friend's index memory in Redis");
              }
              pushTweetInIndexMemory(i+1, callback);
          });
        }
      }

      pushTweetInIndexMemory(0, function(){
        resolved();
        pushTweetInIndexMemory = null;
      })
    })
  }, function(err){
      console.log(err);
  })

  //6. tweetObjectList를 이용해서, 각 surrogate 서버 data 메모리에, 모든 친구들에 대해서 넣는다. 이때 메모리양 체크하면서 넣어야한다.
  .then(function(){
    return new Promise(function(resolved, rejected){
      var pushTweetInDataMemory = function(i, callback){
        if(i >= tweetObjectList.length){
          callback();
        } else {

          //memoryManager에서 메모리 상태를 보고, 아직 공간이 있는지 없는지 확인한다
          /*
            지금 redis.conf에 maxmemory-policy는 allkeys-lru로 해놨다. 최근에 가장 안쓰인 애들을 우선적으로 삭제하는 방식.
            따라서 아래의 메모리 체크 함수 (checkMemory)는 우리가 제안하는 방식에서만 필요하고, baseline approach에서는 필요 없다.
            baseline approach에서는 그냥, 가만히 놔두면 redis설정에 따라 오래된 애들을 우선적으로 지울듯. lru에 따라.
          */
          memoryManager.checkMemory(tweetObjectList[i]);
          pushTweetInDataMemory(i+1, callback);
        }
      }

      pushTweetInDataMemory(0, function(){
        res.json({
          "status" : "OK"
        })

        monitoring.thisHourWrite += 76;
        //operation_log.info("[Write Operation Count]= " + ++monitoring.writeCount  + ", [This Hour Traffic Til Now] = " + monitoring.thisHour + "\n");
        operation_log.info("[Write Operation Count]= " + ++monitoring.writeCount);
        //operation_log.info("[Write Traffic]= " + (monitoring.writeCount * req.body.contentData.length) + "B");
        //operation_log.info();
        tweetObjectList = null;
        pushTweetInDataMemory = null;
        resolved();
      })
    })
  }, function(err){
      console.log(err);
  })

});

module.exports = router;
