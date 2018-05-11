var cron = require('node-cron');

var log4js = require('log4js');
log4js.configure('./configure/log4js.json');
var operation_log = log4js.getLogger("operation");
var error_log = log4js.getLogger("error");
var interim_log = log4js.getLogger("interim");

var redisPool = require('./caching.js');
var dbPool = require('./db.js');
var dbcpPool = require('./db_2.js');
var util = require('./util.js');
var config = require('./configs.js');
var monitoring = require('./monitoring.js');

cron.schedule('30 * * * *', function () {
  console.log("============================ =================== ============================");
  console.log("============================ =================== ============================");
  console.log("============================ periodic task start ============================");
  console.log("============================ =================== ============================");
  console.log("============================ =================== ============================");

  operation_log.info("============================ =================== ============================");
  operation_log.info("============================ =================== ============================");
  operation_log.info("============================ periodic task start ============================");
  operation_log.info("============================ =================== ============================");
  operation_log.info("============================ =================== ============================");

  job.printLatencyDelay();
  job.setLatencyConfigValueZero();
  job.getInterCloudTraffic();
}).start();

var job = {
  printLatencyDelay : function () {
    operation_log.info("[LATENCY DELAY] Sum of latency delay = " + config.eachTimeLatency + ", Num of req. = " + config.eachTimeReqNum + ", Delay = " + config.eachTimeLatency/config.eachTimeReqNum);
  },

  setLatencyConfigValueZero : function () {
    config.eachTimeLatency = 0;
    config.eachTImeReqNum = 0;
  },

  getInterCloudTraffic : function () {
    let TotalIntercloudTrafficAtThisTime = 0;
    var userList = [];
    var promise = new Promise(function(resolved, rejected){
      //모든 유저에 대해서 반복한다.
      //monitoring_rw 테이블에서 모든 row (2001개)를 불러온다. 변수로 저장한다.
      dbPool.getConnection(function(err, conn) {
          let query_stmt = 'SELECT * FROM monitoring_rw';
          conn.query(query_stmt, function(err, result) {
              if(err) {
                 error_log.debug("Query Stmt = " + query_stmt);
                 error_log.debug("ERROR MSG = " + err);
                 error_log.debug();
                 conn.release();
                 rejected("DB err!");
              }
              else {
                for (var j=0; j<result.length; j++) {
                  userList.push(result[j]);
                }
                conn.release();
                resolved();
              }
          });
      });
    });

    promise
    .then(function(){
      return new Promise(function(resolved, rejected){
        //let thisHourInterCloudTraffic = 0;
        let replicaList = [];
        //console.log(userList);
        let calcIntercloudTraffic = function(i, callback){
          if(i >= userList.length){
            callback();
          } else {
            //각 사용자들의 WriteCount와 Cloud_East_ReadCount/Cloud_West_ReadCount/Cloud_Central_ReadCount를 비교한다.
            //WriteCount보다 ReadCount가 더 높은 곳이 있다면 Replication을 한다.
              //이때 해당 를라우드에 이미 리플리케이션이 되어 있지 않는지 Replica 컬럼 데이터로 확인한다.
            if(userList[i].WriteCount < userList[i].Cloud_East_ReadCount){
              if(userList[i].Cloud_East_Replica){ //복제가 되어 있으면.
                //이미 복제되어 있으면,
                  //즉, replica 컬럼에 true 면, 이번 시간 write count 만큼 (writeCount - prevWriteCount) 만 inter cloud traffic 으로 추가한다.
                  let intercloudTrafficForUpdating = 0;
                  intercloudTrafficForUpdating = (userList[i].WriteCount - userList[i].PrevWriteCount) * 1000;
                  operation_log.info("[INTERCLOUD TRAFFIC] User ID : " + userList[i].UserId + ", Intercloud traffic : " + intercloudTrafficForUpdating + " B");
                  TotalIntercloudTrafficAtThisTime += parseInt(intercloudTrafficForUpdating);
              }
              else{
                //복제되어 있지 않으면,
                  //replica 컬럼에 false 면, 해당 사용자의 데이터를 모두 옮겼다고 생각하고, 해당 사용자의 데이서 개수 * 1KB 만큼을 inter cloud traffic 으로 추가한다.
                  let eachReplica = {
                    userId : null,
                    location : null,
                    prevWC : 0,
                    currWC : 0
                  };

                  eachReplica.userId = userList[i].UserId;
                  eachReplica.location = "newyork";
                  replicaList.push(eachReplica);
              }
            }
            if(userList[i].WriteCount < userList[i].Cloud_West_ReadCount){
              if(userList[i].Cloud_West_Replica){ //복제가 되어 있으면.
                //이미 복제되어 있으면,
                  //즉, replica 컬럼에 true 면, 이번 시간 write count 만큼 (writeCount - prevWriteCount) 만 inter cloud traffic 으로 추가한다.
                  let intercloudTrafficForUpdating = 0;
                  intercloudTrafficForUpdating = (userList[i].WriteCount - userList[i].PrevWriteCount) * 1000;
                  operation_log.info("[INTERCLOUD TRAFFIC] User ID : " + userList[i].UserId + ", Intercloud traffic : " + intercloudTrafficForUpdating + " B");
                  TotalIntercloudTrafficAtThisTime += parseInt(intercloudTrafficForUpdating);
              }
              else{
                //복제되어 있지 않으면,
                  //replica 컬럼에 false 면, 해당 사용자의 데이터를 모두 옮겼다고 생각하고, 해당 사용자의 데이서 개수 * 1KB 만큼을 inter cloud traffic 으로 추가한다.
                  let eachReplica = {
                    userId : null,
                    location : null,
                    prevWC : 0,
                    currWC : 0
                  };

                  eachReplica.userId = userList[i].UserId;
                  eachReplica.location = "washington";
                  replicaList.push(eachReplica);
              }
            }
            if(userList[i].WriteCount < userList[i].Cloud_Central_ReadCount){
              if(userList[i].Cloud_Central_Replica){ //복제가 되어 있으면.
                //이미 복제되어 있으면,
                  //즉, replica 컬럼에 true 면, 이번 시간 write count 만큼 (writeCount - prevWriteCount) 만 inter cloud traffic 으로 추가한다.
                  let intercloudTrafficForUpdating = 0;
                  intercloudTrafficForUpdating = (userList[i].WriteCount - userList[i].PrevWriteCount) * 1000;
                  operation_log.info("[INTERCLOUD TRAFFIC] User ID : " + userList[i].UserId + ", Intercloud traffic : " + intercloudTrafficForUpdating + " B");
                  TotalIntercloudTrafficAtThisTime += parseInt(intercloudTrafficForUpdating);
              }
              else{
                //복제되어 있지 않으면,
                  //replica 컬럼에 false 면, 해당 사용자의 데이터를 모두 옮겼다고 생각하고, 해당 사용자의 데이서 개수 * 1KB 만큼을 inter cloud traffic 으로 추가한다.
                  let eachReplica = {
                    userId : null,
                    location : null,
                    prevWC : 0,
                    currWC : 0
                  };

                  eachReplica.userId = userList[i].UserId;
                  eachReplica.location = "texas";
                  replicaList.push(eachReplica);
              }
            }
            calcIntercloudTraffic(i+1, callback);
          }
        }
        calcIntercloudTraffic(0, function(){
          resolved(replicaList);
          calcIntercloudTraffic = null;
        })
      })
    }, function(err){
        console.log(err);
    })
    .then(function(replicaList){
      return new Promise(function(resolved, rejected){
        let doReplicating = function(i, callback){
          if(i >= replicaList.length){
            callback();
          } else {
            //userProperty 테이블에서 사용자 컨텐츠 개수 불러와서 Inter cloud traffic에 더하기
            dbcpPool.getConnection(function(err, conn) {
                let query_stmt = 'SELECT userId, count(*) as contentCnt FROM userProperty ' +
                                 'WHERE userId = "' + replicaList[i].userId + '" ' +
                                 'GROUP BY userId';
                console.log("[FROM USER PROPERTY TABLE][" + i + "/" + replicaList.length + "]");
                //operation_log.info("QUERY STMT : " + query_stmt);
                conn.query(query_stmt, function(err, result) {
                    if(err) {
                       error_log.debug("Query Stmt = " + query_stmt);
                       error_log.debug("ERROR MSG = " + err);
                       error_log.debug();
                       conn.release();
                       rejected("DB err!");
                    }
                    else {
                      let intercloudTrafficForReplicating = 0;
                      intercloudTrafficForReplicating += result[0].contentCnt;
                      intercloudTrafficForReplicating *= 1000;
                      //operation_log.info("[INTERCLOUD TRAFFIC] User ID : " + replicaList[i].userId + ", Intercloud traffic : " + intercloudTrafficForReplicating + " B");
                      TotalIntercloudTrafficAtThisTime += intercloudTrafficForReplicating;
                      conn.release();
                      doReplicating(i+1, callback);
                    }
                });
            });
          }
        }
        doReplicating(0, function(){
          operation_log.info("[TOTAL INTERCLOUD TRAFFIC AT THIS TIME] " + parseInt(TotalIntercloudTrafficAtThisTime) + " B");
          resolved(replicaList);
          doReplicating = null;
        })
      })
    }, function(err){
        console.log(err);
    })
    //monitoring_rw 테이블에 replicate 했다고 업데이트 하기
    .then(function(replicaList){
      return new Promise(function(resolved, rejected){
        let changeStatusReplica = function(i, callback){
          if(i >= replicaList.length){
            callback();
          } else {
            let replicaLocation = null;
            if(replicaList[i].location == "newyork"){
              replicaLocation = "Cloud_East_Replica";
            }
            else if(replicaList[i].location == "washington"){
              replicaLocation = "Cloud_West_Replica";
            }
            else if(replicaList[i].location == "texas"){
              replicaLocation = "Cloud_Central_Replica";
            }
            else{
              console.error("Location was wrong..! ");
            }
            dbPool.getConnection(function(err, conn) {
                let query_stmt = 'UPDATE monitoring_rw SET ' + replicaLocation + ' = true ' +
                                 'WHERE UserId = "' + replicaList[i].userId + '"'
                console.log("[UPDATING monitoring_rw TABLE][" + i + "/" + replicaList.length + "]");
                conn.query(query_stmt, function(err, result) {
                    if(err) {
                       error_log.debug("Query Stmt = " + query_stmt);
                       error_log.debug("ERROR MSG = " + err);
                       error_log.debug();
                       rejected("DB err!");
                    }
                    else{
                      conn.release();
                      changeStatusReplica(i+1, callback);
                    }
                });
            });
          }
        }
        changeStatusReplica(0, function(){
          resolved();
          changeStatusReplica = null;
        })
      })
    }, function(err){
        console.log(err);
    })
    //prevWriteCount 업데이트
    .then(function(){
      return new Promise(function(resolved, rejected){
        let changePrevWriteCount = function(i, callback){
          if(i >= userList.length){
            callback();
          } else {
            dbPool.getConnection(function(err, conn) {
                let query_stmt = 'UPDATE monitoring_rw SET PrevWriteCount = ' + userList[i].WriteCount + ' ' +
                                 'WHERE UserId = "' + userList[i].UserId + '"'
                console.log("[CHANGE PREV WRITE COUNT][" + i + "/" + userList.length + "]");
                conn.query(query_stmt, function(err, result) {
                    if(err) {
                       error_log.debug("Query Stmt = " + query_stmt);
                       error_log.debug("ERROR MSG = " + err);
                       error_log.debug();
                       rejected("DB err!");
                    }
                    else{
                      conn.release();
                      changePrevWriteCount(i+1, callback);
                    }
                });
            });
          }
        }
        changePrevWriteCount(0, function(){
          resolved();
          // res.json({
          //   status : "OK"
          // });
          changePrevWriteCount = null;
        })
      })
    }, function(err){
        console.log(err);
    })
  },

  setUserContents : function () {
    var EACH_DATA_SIZE = 76;
    //해당 클라우드로 접속하는 사용자 리스트 알아야 한다 <-- DB에 쿼리 날려보면 됨, select * from newyork; 이런식?

    //2.
      //모든 사용자에 대해서 해야함.
      //각 사용자들에게 할당되어 있는 메모리 사이즈를 가지고 옴

      /*
      //만약에 각 데이터의 사이즈가 정해져있다면
      //자신에게 할당되어 있는 메모리 사이즈를 넘지 않는 최대 개수 만큼 데이터를 가지고 온다
        //레디스의 lrange 로 개수 만큼 인덱스를 가져와서
        //그 인덱스가 DB에서도 ID 값이니까 그걸로 데이터를 불러서 set 한다.
      */
    var serverLocation;
    var userList = [];
    var userMaxNumData = [];
    var usersContentIndexList = [];
    var usersDataList = [];

    var current_hour;
    var usage_sum;
    var usersMemory = [];
    var serverLocation;

    var preSetList = [];

    var MAX_MEMORY = config.totalMemory;

    var promise = new Promise(function(resolved, rejected){
      redisPool.flushDataMemory();
      redisPool.flushSocialMemory();
      setTimeout(function() {
        resolved();
      }, 5000);

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
            //var next_hour = current_hour + 1; // 다음 시간의 사용량을 보고, 미리 캐싱하는 것이므로
            var query_stmt = 'SELECT SUM(B.' + next_hour + 'h) AS usage_sum ' +
                             'FROM ' + serverLocation + ' A JOIN user_usage B ' +
                             'ON A.userId = B.userId';
            //console.log(query_stmt);
            conn.query(query_stmt, function(err, rows) {
                if(err) {
                   error_log.info("fail to get the sum of user usages : " + err);
                   error_log.info("query statement : " + query_stmt);
                   rejected("DB err!");
                }
                else if(rows.length != 0 || rows == undefined){
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
    //다음 시간에 각 사용자의 사용량 구하기
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
            //console.log(query_stmt);
            conn.query(query_stmt, function(err, rows) {
                if(err) {
                   error_log.info("fail to get user usage : " + err);
                   error_log.info("query statement : " + query_stmt);
                   rejected("DB err!");
                }
                for (var i=0; i<rows.length; i++) {
                  var portion =  rows[i].eachUsage / usage_sum;
                  var userMemory = MAX_MEMORY * portion;
                  var maxNumData = parseInt(userMemory / EACH_DATA_SIZE);

                  //console.log("USER ID = " + rows[i].userId + ", PORTION = " + portion + ", MEMORY SIZE = " + userMemory + ", MAXNUMDATA = " + maxNumData);
                  //operation_log.info("USER ID = " + rows[i].userId + ", PORTION = " + portion + ", MEMORY SIZE = " + userMemory + ", MAXNUMDATA = " + maxNumData);

                  usersMemory.push({
                      userId : rows[i].userId,
                      userPortion : portion,
                      userMemory : userMemory,
                      numData : maxNumData
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
                //console.log("["+ i +"] key : " + key + ", value : " + value);
                operation_log.info("["+ i +"] key (User ID) : " + key + ", value (Original Memory Size At This Time) : " + value);
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

    // 각 유저에게 할당된 메모리양에 맞게 데이터 불러오기
    .then(function(){
      return new Promise(function(resolved, rejected){
        var getDataIndexes = function(i, callback){
          if(i >= usersMemory.length){
            callback();
          } else {

            if(usersMemory[i].numData == 0){
              getDataIndexes(i+1, callback);
            }
            else {
              var key = usersMemory[i].userId;
              var start = 0;
              var end = usersMemory[i].numData - 1; // 데이터 인덱스가 0부터 시작하므로
              //console.log("Get Data Indexes Phase : Key = " + key + ", Start = " + start + ", End = " + end + ", User Max Data = " + usersMemory[i].numData);
              operation_log.info("Get Data Indexes Phase : Key = " + key + ", Start = " + start + ", End = " + end + ", User Max Data = " + usersMemory[i].numData);
              redisPool.indexMemory.lrange(key, start, end, function (err, result) {
                  if(err){
                    error_log.info("fail to get the index memory in Redis : " + err);
                    error_log.info("key (req.params.userId) : " + key + ", start : " + start + ", end : " + end);
                    error_log.info();
                    rejected("fail to get the index memory in Redis");
                  }

                  usersContentIndexList.push({
                    userId : key,
                    indexList : result
                  });
                  getDataIndexes(i+1, callback);
              });
            }

          }
        };

        getDataIndexes(0, function(){
          resolved();
          getDataIndexes = null;
        })
      })
    }, function(err){
        console.log(err);
    })

    .then(function(){
      return new Promise(function(resolved, rejected){
        //console.log(usersContentIndexList);
        var getDataFromDB = function(i, callback){
          if(i >= usersContentIndexList.length){
            callback();
          } else {

            //----------------------------------------------------------------//
            dbPool.getConnection(function(err, conn) {

              var query_stmt = 'SELECT B.userId, A.id, A.message ' +
                               'FROM content A ' +
                               'JOIN user B ' +
                               'ON A.uid = B.id ' +
                               'WHERE B.userId = "' + usersContentIndexList[i].userId + '" ';

              var additionalQueryString = "";
              //var preSetNum = 0;
              for(var j=0; j<usersContentIndexList[i].indexList.length; j++){
                  additionalQueryString += function(idx) {

                          if (idx == 0 && idx == usersContentIndexList[i].indexList.length - 1){
                              return 'AND (A.id = ' + usersContentIndexList[i].indexList[idx] + ')';

                          } else if(idx == 0 && idx != usersContentIndexList[i].indexList.length - 1){
                              return 'AND (A.id = ' + usersContentIndexList[i].indexList[idx];

                          } else if (idx != 0 && idx != usersContentIndexList[i].indexList.length - 1){
                              return ' OR A.id = ' + usersContentIndexList[i].indexList[idx];

                          } else if (idx != 0 && idx == usersContentIndexList[i].indexList.length - 1) {
                              return ' OR A.id = ' + usersContentIndexList[i].indexList[idx] + ')';
                          }
                          //preSetNum++;

                  }(j);
              }

              preSetList.push({
                userId : usersContentIndexList[i].userId,
                numContents : usersContentIndexList[i].indexList.length
              })
              query_stmt += additionalQueryString;

              conn.query(query_stmt, function(err, result) {
                  if(err){
                    error_log.info("fail to get user contents from MySQL! : " + err);
                    error_log.info("query statement : " + query_stmt);
                    conn.release(); //MySQL connection release
                    rejected("fail to get user contents from MySQL!");
                  }
                  else if(result == undefined || result == null){
                    error_log.info("fail to get user contents from MySQL! : There is no result.");
                    error_log.info("query statement : " + query_stmt);
                    conn.release(); //MySQL connection release
                    rejected("fail to get user location from MySQL!");
                  }
                  else {
                    for (var k=0; k<result.length; k++) {
                      usersDataList.push({
                          userId : result[k].userId,
                          contentId : result[k].id,
                          message : result[k].message
                      });
                    }
                    conn.release(); //MySQL connection release
                    getDataFromDB(i+1, callback);
                  }
              })
            });
            //----------------------------------------------------------------//

          }
        };

        getDataFromDB(0, function(){
          resolved();
          getDataFromDB = null;
        })
      })
    }, function(err){
        console.log(err);
    })
    .then(function(contentIndexList){
      return new Promise(function(resolved, rejected){

        var modifyUserMemorySize = function(i, callback){
          if(i >= preSetList.length){
            callback();
          } else {
            var key = preSetList[i].userId;
            redisPool.socialMemory.get(key, function (err, result) {
                if(err){
                  error_log.info("fail to get the user memory size in Redis : " + err);
                  error_log.info("fail to get the user memory size in Redis : " + err);
                  error_log.info();
                }
                else if(result) {
                  var newUserMemorySize = result - preSetList[i].numContents * EACH_DATA_SIZE;
                  var value = newUserMemorySize;
                  redisPool.socialMemory.set(key, value, function (err) {
                      if(err) rejected("fail to initialize the social memory in Redis");
                      //console.log("["+ i +"] key : " + key + ", value : " + value);
                      else {
                        //console.log("USER ID = " + key + ", NEW MEMORY SIZE = " + value + ", CONTENTS_NUM = " + preSetList[i].numContents+ ", EACH_DATA_SIZE = " + EACH_DATA_SIZE);
                        operation_log.info("USER ID = " + key + ", NEW MEMORY SIZE = " + value + ", CONTENTS_NUM = " + preSetList[i].numContents + ", EACH_DATA_SIZE = " + EACH_DATA_SIZE);

                        modifyUserMemorySize(i+1, callback);
                      }
                  });
                }
            });

          }
        };

        modifyUserMemorySize(0, function(){
          resolved();
          modifyUserMemorySize = null;
        })

      })
    }, function(err){
        console.log(err);
    })
    .then(function(contentIndexList){
      return new Promise(function(resolved, rejected){

        var setDataIntoMemory = function(i, callback){
          if(i >= usersDataList.length){
            callback();
          } else {

            var key = usersDataList[i].contentId;
            var value = usersDataList[i].message;
            redisPool.dataMemory.set(key, value, function (err) {
                if(err){
                  error_log.info("fail to push the content into friend's data memory in Redis : " + err);
                  error_log.info("key (tweetObject.contentId) : " + key + ", value (tweetObject.content) : " + value);
                  error_log.info();
                }
                else {
                  setDataIntoMemory(i+1, callback);
                }
            });

          }
        };

        setDataIntoMemory(0, function(){
          resolved();
          setDataIntoMemory = null;
        })

      })
    }, function(err){
        console.log(err);
    })
    .then(function(){
      return new Promise(function(resolved, rejected){
        console.log("setting data in data memory was completed")
        resolved();
        //cb();
      })
    }, function(err){
        console.log(err);
    })

    /*
    //만약에 각 데이터의 사이즈가 안정해져있다면
    //자신에게 할당되어 있는 메모리 사이즈를 넘지 않는 최대 개수 만큼 데이터를 가지고 온다
      //레디스의 lrange 로 개수 만큼 인덱스를 가져와서
      //그 인덱스가 DB에서도 ID 값이니까 그걸로 데이터를 불러서 set 한다.
    */
  }
}

module.exports = job;
