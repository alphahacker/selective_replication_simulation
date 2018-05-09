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
router.get('/intercloud_test', function(req, res, next) {
  job.getInterCloudTraffic();
});

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
            var query_stmt = 'INSERT INTO monitoring_rw VALUES("' + users[i] + '", 0, 0, 0, 0, false, false, false, 0)';
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
      //console.log("USER - " + req.params.userId);
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
                      //console.log(query_stmt3);
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
        resolved(friendList);
        incrReadCount = null;
      })
    })
  }, function(err){
      console.log(err);
  })
  .then(function(friendList){
    return new Promise(function(resolved, rejected){
      var calcLatencyDelay = function(i, callback){
        if(i >= friendList.length){
          callback();
        } else {
          //req.params.userId 사용자 위치와, friendList[i] 사용자 위치 구하기
          let userLocation = null;
          let friendLocation = null;

          let userCloudLocation = config.serverLocation;
          let friendCloudLocation = null;

          ////////////////////////////////////////////////////////////////////////////////////////////////////////////////
          //사용자와 친구 위치 가져오기
          redisPool.locationMemory.get(req.params.userId, function (err, resultUserLocation) {
              if(err) rejected("fail to get user location memory in Redis when getting latency delay...(1)");
              else{
                userLocation = resultUserLocation;
                redisPool.locationMemory.get(friendList[i], function (err, resultFriendLocation) {
                    if(err) rejected("fail to get user location memory in Redis when getting latency delay...(2)");
                    else{
                      friendLocation = resultFriendLocation;
                      ////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                      //사용자와 친구 클라우드 위치 가져오기.
                      dbPool.getConnection(function(err, conn) {
                        var query_stmt5 = 'SELECT dstLocation FROM targetLocation WHERE srcLocation = "' + friendLocation + '"'
                        //console.log(query_stmt5);
                        conn.query(query_stmt5, function(err, friendCloudLocationResult) {
                          if(err) {
                            error_log.debug("Query Stmt = " + query_stmt5);
                            error_log.debug("ERROR MSG = " + err);
                            error_log.debug();
                            rejected("DB err!");
                          } else {
                            friendCloudLocation = friendCloudLocationResult[0].dstLocation;
                            //console.log("friend cloud location : " + friendCloudLocation);
                            //console.log("friend cloud location (query result) : " + friendCloudLocationResult);
                            conn.release();

                            if(userCloudLocation == friendCloudLocation){
                              // user cloud location 과 friend cloud location 이 같다면,
                              // 사용자의 위치와 사용자의 가장 가까운 클라우드 간의 거리 측정하고 딜레이 계산 + 로깅
                              operation_log.info("[Read Latency Delay]= " + util.getLatencyDelay(coord[userLocation.toUpperCase()], coord[userCloudLocation.toUpperCase()]) + "ms, " +
                                                 "[USER ID] = " + req.params.userId + ", [USER LOCATION] = " + userLocation + ", [USER CLOUD LOCATION] = " + userCloudLocation + ", " +
                                                 "[FRIEND ID] = " + friendList[i] + ", [FRIEND LOCATION] = " + friendLocation + ", [FRIEND CLOUD LOCATION] = " + friendCloudLocation);
                              calcLatencyDelay(i+1, callback);
                            } else {
                              // user cloud location 과 friend cloud location 이 다르다면,
                              // 해당 클라우드에 복제 여부를 체크한다.
                              let isReplicated = false;
                              dbPool.getConnection(function(err, conn) {
                                  let query_stmt5 = 'SELECT * FROM monitoring_rw WHERE UserId = "' + friendList[i] + '"';
                                  conn.query(query_stmt5, function(err, result) {
                                      if(err) {
                                         error_log.debug("Query Stmt = " + query_stmt5);
                                         error_log.debug("ERROR MSG = " + err);
                                         error_log.debug();
                                         conn.release();
                                         rejected("DB err!");
                                      }
                                      else {
                                        // 복제되어 있다면, 친구의 위치와 friend cloud location 간의 거리에 따라 딜레이 계산하고 로그 남긴다.
                                        // 복제되어있지 않다면, 친구의 위치와 user cloud location 간의 거리에 따라 딜레이 계산하고 로그 남긴다.
                                        if(userLocation == 'NEWYORK'){
                                          isReplicated = result[0].Cloud_East_Replica;
                                        } else if (userLocation == 'WASHINGTON') {
                                          isReplicated = result[0].Cloud_West_Replica;
                                        } else if (userLocation == 'TEXAS') {
                                          isReplicated = result[0].Cloud_Central_Replica;
                                        } else {
                                          console.error("Cloud Location / Read Count Error ! ... (2)");
                                          console.error("User Location : " + userLocation);
                                          console.error("Friend ID : " + friendList[i]);
                                        }

                                        conn.release();

                                        if(isReplicated){
                                          //복제되어 있으면, 사용자 위치와 사용자의 가장 가까운 클라우드 간의 거리 계산
                                          operation_log.info("[Read Latency Delay]= " + util.getLatencyDelay(coord[userLocation.toUpperCase()], coord[userCloudLocation.toUpperCase()]) + "ms, " +
                                                             "[USER ID] = " + req.params.userId + ", [USER LOCATION] = " + userLocation + ", [USER CLOUD LOCATION] = " + userCloudLocation + ", " +
                                                             "[FRIEND ID] = " + friendList[i] + ", [FRIEND LOCATION] = " + friendLocation + ", [FRIEND CLOUD LOCATION] = " + friendCloudLocation);
                                        } else {
                                          //복제되어 있지 않으면, 사용자 위치와 친구의 가장 가까운 클라우드 간의 거리 계산
                                          //console.log("coord test : ");
                                          //console.log(coord[userLocation]);
                                          //console.log(coord[friendCloudLocation]);
                                          operation_log.info("[Read Latency Delay]= " + util.getLatencyDelay(coord[userLocation.toUpperCase()], coord[friendCloudLocation.toUpperCase()]) + "ms, " +
                                                             "[USER ID] = " + req.params.userId + ", [USER LOCATION] = " + userLocation + ", [USER CLOUD LOCATION] = " + userCloudLocation + ", " +
                                                             "[FRIEND ID] = " + friendList[i] + ", [FRIEND LOCATION] = " + friendLocation + ", [FRIEND CLOUD LOCATION] = " + friendCloudLocation);
                                        }
                                        calcLatencyDelay(i+1, callback);
                                      }

                                  });
                              });
                            }
                          }
                        });
                      });
                      // dbPool.getConnection(function(err, conn) {
                      //   var query_stmt4 = 'SELECT dstLocation FROM targetLocation WHERE srcLocation = "' + userLocation + '"'
                      //   conn.query(query_stmt4, function(err, userCloudLocationResult) {
                      //     if(err) {
                      //       error_log.debug("Query Stmt = " + query_stmt4);
                      //       error_log.debug("ERROR MSG = " + err);
                      //       error_log.debug();
                      //       rejected("DB err!");
                      //     } else {
                      //       userCloudLocation = userCloudLocationResult;
                      //       conn.release();
                      //       dbPool.getConnection(function(err, conn) {
                      //         var query_stmt5 = 'SELECT dstLocation FROM targetLocation WHERE srcLocation = "' + friendLocation + '"'
                      //         conn.query(query_stmt5, function(err, friendCloudLocationResult) {
                      //           if(err) {
                      //             error_log.debug("Query Stmt = " + query_stmt5);
                      //             error_log.debug("ERROR MSG = " + err);
                      //             error_log.debug();
                      //             rejected("DB err!");
                      //           } else {
                      //             friendCloudLocation = friendCloudLocationResult;
                      //             conn.release();
                      //
                      //             if(userCloudLocation == friendCloudLocation){
                      //               // user cloud location 과 friend cloud location 이 같다면,
                      //               // 사용자의 위치와 사용자의 가장 가까운 클라우드 간의 거리 측정하고 딜레이 계산 + 로깅
                      //               operation_log.info("[Read Latency Delay]= " + util.getLatencyDelay(coord[userLocation], coord[userCloudLocation]) + "ms, " +
                      //                                  "[USER ID] = " + req.params.userId + ", [USER LOCATION] = " + userLocation + ", [USER CLOUD LOCATION] = " + userCloudLocation + ", " +
                      //                                  "[FRIEND ID] = " + friendList[i] + ", [FRIEND LOCATION] = " + friendLocation + ", [FRIEND CLOUD LOCATION] = " + friendCloudLocation);
                      //               calcLatencyDelay(i+1, callback);
                      //             } else {
                      //               // user cloud location 과 friend cloud location 이 다르다면,
                      //               // 해당 클라우드에 복제 여부를 체크한다.
                      //               let isReplicated = false;
                      //               let toBeCheckedCloud = null;
                      //
                      //               if(friendCloudLocation == 'newyork'){
                      //                 toBeCheckedCloud = "Cloud_East_Replica";
                      //               } else if (friendCloudLocation == 'washington') {
                      //                 toBeCheckedCloud = "Cloud_West_Replica";
                      //               } else if (friendCloudLocation == 'texas') {
                      //                 toBeCheckedCloud = "Cloud_Central_Replica";
                      //               } else {
                      //                 console.error("Cloud Location / Read Count Error !");
                      //                 console.error("User Locaiton : " + userLocation);
                      //                 console.error("Friend ID : " + friendList[i]);
                      //               }
                      //               dbPool.getConnection(function(err, conn) {
                      //                   let query_stmt5 = 'SELECT * FROM monitoring_rw WHERE UserId = "' + friendList[i] + '"';
                      //                   conn.query(query_stmt5, function(err, result) {
                      //                       if(err) {
                      //                          error_log.debug("Query Stmt = " + query_stmt5);
                      //                          error_log.debug("ERROR MSG = " + err);
                      //                          error_log.debug();
                      //                          conn.release();
                      //                          rejected("DB err!");
                      //                       }
                      //                       else {
                      //                         // 복제되어 있다면, 친구의 위치와 friend cloud location 간의 거리에 따라 딜레이 계산하고 로그 남긴다.
                      //                         // 복제되어있지 않다면, 친구의 위치와 user cloud location 간의 거리에 따라 딜레이 계산하고 로그 남긴다.
                      //                         if(userLocation == 'newyork'){
                      //                           isReplicated = result[0].Cloud_East_Replica;
                      //                           //toBeCheckedCloud = "Cloud_East_Replica";
                      //                         } else if (userLocation == 'washington') {
                      //                           isReplicated = result[0].Cloud_West_Replica;
                      //                           //toBeCheckedCloud = "Cloud_West_Replica";
                      //                         } else if (userLocation == 'texas') {
                      //                           isReplicated = result[0].Cloud_Central_Replica;
                      //                           //toBeCheckedCloud = "Cloud_Central_Replica";
                      //                         } else {
                      //                           console.error("Cloud Location / Read Count Error ! ... (2)");
                      //                           console.error("User Locaiton : " + userLocation);
                      //                           console.error("Friend ID : " + friendList[i]);
                      //                         }
                      //
                      //                         conn.release();
                      //
                      //                         if(isReplicated){
                      //                           //복제되어 있으면, 사용자 위치와 사용자의 가장 가까운 클라우드 간의 거리 계산
                      //                           operation_log.info("[Read Latency Delay]= " + util.getLatencyDelay(coord[userLocation], coord[userCloudLocation]) + "ms, " +
                      //                                              "[USER ID] = " + req.params.userId + ", [USER LOCATION] = " + userLocation + ", [USER CLOUD LOCATION] = " + userCloudLocation + ", " +
                      //                                              "[FRIEND ID] = " + friendList[i] + ", [FRIEND LOCATION] = " + friendLocation + ", [FRIEND CLOUD LOCATION] = " + friendCloudLocation);
                      //                         } else {
                      //                           //복제되어 있지 않으면, 사용자 위치와 친구의 가장 가까운 클라우드 간의 거리 계산
                      //                           console.log("coord test : ");
                      //                           console.log(coord[userLocation]);
                      //                           console.log(coord[friendCloudLocation]);
                      //                           operation_log.info("[Read Latency Delay]= " + util.getLatencyDelay(coord[userLocation], coord[friendCloudLocation]) + "ms, " +
                      //                                              "[USER ID] = " + req.params.userId + ", [USER LOCATION] = " + userLocation + ", [USER CLOUD LOCATION] = " + userCloudLocation + ", " +
                      //                                              "[FRIEND ID] = " + friendList[i] + ", [FRIEND LOCATION] = " + friendLocation + ", [FRIEND CLOUD LOCATION] = " + friendCloudLocation);
                      //                         }
                      //                         calcLatencyDelay(i+1, callback);
                      //                       }
                      //
                      //                   });
                      //               });
                      //             }
                      //           }
                      //         });
                      //       });
                      //     }
                      //   });
                      // });
                      ////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                    }
                });
              }
          });
          ////////////////////////////////////////////////////////////////////////////////////////////////////////////////
        }
      }
      calcLatencyDelay(0, function(){
        resolved();
        calcLatencyDelay = null;
      })

      //해당 친구의 데이터가, req.params.userId에 해당하는 사용자가 access하는 클라우드 (WEST, CENTRAL, EAST)에 복제되어 있는지 확인
        // if(config.serverLocation == 'newyork'){
        //   cloudLocation = 'Cloud_East_ReadCount';
        // } else if (config.serverLocation == 'texas') {
        //   cloudLocation = 'Cloud_Central_ReadCount';
        // } else if (config.serverLocation == 'washington') {
        //   cloudLocation = 'Cloud_West_ReadCount';
        // } else {
        //   console.error("Wrong cloud location!");
        // }

      //(다른 클라우드에 복제되어있는지 여부를 판단할때, 두 사용자가 애초에 같은 클라우드로 액세스하는건 아닌지 확인해봐야한다.)
      //(액세스하는 사용자가(req.params.userId) 액세스하는 클라우드는 serverLocation에 저장되어 있을테니, )
      //(그거 외에 다른 두개에 대해서 검사를 해보면 됨.)
      //만약에 복제되어 있다면,
        // req.params.userId 위치와 serverLocation에 간의 거리 계산.
          // 각 사용자의 위치는 redisPool.locationMemory로 알 수 있음.
            // 각 위치에 대한 coord 값은 coord[rows[i].location] = { lat : rows[i].lat, lng : rows[i].lng }; 로 알 수 있음

      //만약에 복제되어 있지 않다면,
        // req.params.userId 위치와 해당 친구가 access 하는 클라우드의 serverLocation 간의 거리 계산
          //친구가 액세스하는 클라우드의 위치를 알려면..
    })
  }, function(err){
      console.log(err);
  })
  .then(function(){
    return new Promise(function(resolved, rejected){

      // 여기서 latency delay 계산해주고,
        //latency delay 계산할때 monitoring_rw 테이블의 replica 컬럼 보고, replica 에 해당 클라우드에 read 대상이 되는 사용자의
        //데이터가 복제되어 있으면 (true), read 주체가 되는 사용자와 가장 가까운 클라우드 간의 거리만 측정.
        //replica가 false면, read 대상이 되는 사용자와 가장 가까운 클라우드와 read 주체가 되는 사용자 간의 거리 측정.
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
                 error_log.debug("Query Stmt = " + query_stmt2);
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
