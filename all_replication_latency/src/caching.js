var redis = require('redis');

var redisClient = {};

var log4js = require('log4js');
log4js.configure('./configure/log4js.json');
var operation_log = log4js.getLogger("operation");
var error_log = log4js.getLogger("error");
var interim_log = log4js.getLogger("interim");

// redisClient.indexMemory = redis.createClient(1234, '127.0.0.1');
// redisClient.dataMemory = redis.createClient(1235, '127.0.0.1');
// redisClient.socialMemory = redis.createClient(1236, '127.0.0.1');
// redisClient.locationMemory = redis.createClient(1237, '127.0.0.1');

redisClient.connectClients = function (redisIp) {
  redisClient.indexMemory = redis.createClient(1234, redisIp);      //사용자가 업로드한 컨텐츠 데이터에 대한 인덱스가 저장되는 곳
  redisClient.dataMemory = redis.createClient(1235, redisIp);       //실제로 컨텐츠 데이터가 저장되는 곳
  redisClient.socialMemory = redis.createClient(1236, redisIp);     //각 사용자에게 할당된 메모리양이 저장되는 곳
  redisClient.locationMemory = redis.createClient(1237, redisIp);   //사용자의 위치가 저장되어있는 곳
  redisClient.friendListMemory = redis.createClient(1238, redisIp);   //사용자의 친구들 리스트가 저장되어있는 곳

  console.log("redis connection complete");
}

redisClient.flushMemory = function () {
  redisClient.indexMemory.flushdb( function (err, succeeded) {
      if(err) throw err;
      console.log("index memory flush completed"); // will be true if successfull
  });

  redisClient.dataMemory.flushdb( function (err, succeeded) {
      if(err) throw err;
      console.log("data memory flush completed"); // will be true if successfull
      operation_log.info("data memory flush completed")
  });

  redisClient.socialMemory.flushdb( function (err, succeeded) {
      if(err) throw err;
      console.log("social memory flush completed"); // will be true if successfull
      operation_log.info("social memory flush completed")
  });

  redisClient.locationMemory.flushdb( function (err, succeeded) {
      if(err) throw err;
      console.log("location memory flush completed"); // will be true if successfull
  });

  redisClient.friendListMemory.flushdb( function (err, succeeded) {
    if(err) throw err;
    console.log("friend list memory flush completed"); // will be true if successfull
});
}

redisClient.flushDataMemory = function () {
  redisClient.dataMemory.flushdb( function (err, succeeded) {
      if(err) throw err;
      console.log("data memory flush completed"); // will be true if successfull
  });
}

redisClient.flushSocialMemory = function () {
  redisClient.socialMemory.flushdb( function (err, succeeded) {
      if(err) throw err;
      console.log("social memory flush completed"); // will be true if successfull
  });
}

module.exports = redisClient;

////////////////////////////////////////////////////////////////////////////////
/*
var redis = {};

redis.flushMemory = function () {
    var redis = require('redis');
    indexMemoryClient = redis.createClient(1234, '127.0.0.1');
    dataMemoryClient = redis.createClient(1235, '127.0.0.1');
    socialMemoryClient = redis.createClient(1236, '127.0.0.1');

    indexMemoryClient.flushdb( function (err, succeeded) {
        if(err) throw err;
        console.log("index memory flush completed"); // will be true if successfull
    });

    dataMemoryClient.flushdb( function (err, succeeded) {
        if(err) throw err;
        console.log("data memory flush completed"); // will be true if successfull
    });

    socialMemoryClient.flushdb( function (err, succeeded) {
        if(err) throw err;
        console.log("social memory flush completed"); // will be true if successfull
    });
}

redis.indexMemory = require('redis-connection-pool')('indexMemoryPool', {
    host : '127.0.0.1',
    port : 1234,
    max_clients : 30,
    perform_checks : false
});

redis.dataMemory = require('redis-connection-pool')('dataMemoryPool', {
    host : '127.0.0.1',
    port : 1235,
    max_clients : 30,
    perform_checks : false
});

redis.socialMemory = require('redis-connection-pool')('socialMemoryPool', {
    host : '127.0.0.1',
    port : 1236,
    max_clients : 30,
    perform_checks : false
});
*/
// redis.friendListMemory = require('redis-connection-pool')('myRedisPool', {
//     host : '127.0.0.1',
//     port : 1237,
//     max_clients : 30,
//     perform_checks : false
// });

// redis.indexMemory = require('redis-pooling')({
//     maxPoolSize: 10,
//     credentials: {
//         host: "127.0.0.1",
//         port: "1234"
//     }
// });
//
// redis.dataMemory = require('redis-pooling')({
//     maxPoolSize: 10,
//     credentials: {
//         host: "127.0.0.1",
//         port: "1235"
//     }
// });
//
// redis.socialMemory = require('redis-pooling')({
//     maxPoolSize: 10,
//     credentials: {
//         host: "127.0.0.1",
//         port: "1236"
//     }
// });
//
//module.exports = redis;
