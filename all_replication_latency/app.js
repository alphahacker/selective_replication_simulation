var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var session = require('express-session');
var Promise = require('promise');

// var aws = require('aws-sdk');
// var multerS3 = require('multer-s3');
// aws.config.update({
// secretAccessKey: '4n/EzMX8nTcTOG3LQSCvwUzSGs2J+D+Vte7TY6tL',
// accessKeyId: 'AKIAJPACEPUSNEAEQOPA',
// region: 'ap-northeast-2'
// });
// var s3 = new aws.S3();

//----------------------------------------------------------------//

var dbPool = require('./src/db.js');
var redisPool = require('./src/caching.js');
var util = require('./src/util.js');
var config = require('./src/configs.js');
var monitoring = require('./src/monitoring.js');
var coord = require('./src/coord.js');

//----------------------------------------------------------------//

//var redis = require('./routes/redis');
var redirector = require('./routes/redirector_recv');
var timeline = require('./routes/timeline');

//----------------------------------------------------------------//

var app = express();

//----------------------------------------------------------------//

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');
//app.use(logger('dev'));
app.use(bodyParser.json({limit: '50mb'}));
app.use(bodyParser.urlencoded({limit: '50mb', extended: true}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

//----------------------------------------------------------------//

//app.use('/', routes);
//app.use('/users', users);
//app.use('/redis', redis);
app.use('/redirector', redirector);
app.use('/timeline', timeline);

//----------------------------------------------------------------//

var init = function() {

    //monitoring 값 초기화
    monitoring.cacheHit = 0;
    monitoring.cacheMiss = 0;
    monitoring.traffic = 0;
    monitoring.readCount = 0;
    monitoring.writeCount = 0;
    monitoring.thisHourRead = 0;
    monitoring.thisHourWrite = 0;

    //각자의 서버에서 자신의 IP를 파악한 후,
    //그 IP값을 이용해서 각자의 Redis에 커넥션을 맺는다.
    var promise = new Promise(function(resolved, rejected){
      var redisIp;
      var thisServerIp = util.serverIp();
      if(thisServerIp == '165.132.104.210') {
          redisIp = '165.132.104.210';
      }
      else if (thisServerIp == '165.132.104.208') {
          redisIp = '165.132.104.208';
      }
      else if (thisServerIp == '165.132.104.193') {
          redisIp = '165.132.104.193';
      }
      else if (thisServerIp == '165.132.104.209') {
          redisIp = '165.132.104.209';
      }
      else if (thisServerIp == '192.168.0.11') {
          redisIp = '192.168.0.11';
      }
      else {
          console.log("Wrong access IP!");
      }
      redisPool.connectClients(redisIp);
      resolved();
    });

    promise
    .then(function(result){
      return new Promise(function(resolved, rejected){
        //기존에 redis에 있던 내용들 다 지워버려야 함
        try {
          redisPool.flushMemory();
          resolved();
        } catch (e) {
          rejected("flush error!");
        }
      })
    }, function(err){
        console.log(err);
    })

    /* 나머지 init과 관련한 부분은 timeline.js의 GET /init 에서 처리해준다
    이렇게 했던 이유는 여기 app.js에다가 해놓으니까, node.js cluster 기능을 이용하여,
    코어 개수에 맞게 노드가 돌도록 (그러니까, 코어가 4개면 4개의 노드가 켜지고, 리퀘스트가 라운드로빈 방식으로 들어감)
    하면, 초기화가 4번 일어나길래 한번만 하게 하려고 따로 뺐다.

    만약에 각 코어에 노드가 독립적으로 운용되도 상관없다면 초기화를 각 노드에서 해줘도 된다.
    그러나, 각 노드가 하나의 캐쉬나 하나의 디비를 봐야하는 상황이라면 고민을 해볼 필요가 있다. */
}();

//----------------------------------------------------------------//

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

//----------------------------------------------------------------//

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
  app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
      message: err.message,
      error: err
    });
  });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
  res.status(err.status || 500);
  res.render('error', {
    message: err.message,
    error: {}
  });
});

//----------------------------------------------------------------//

module.exports = app;
