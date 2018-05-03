var dbPool = require('mysql').createPool({
    connectionLimit : 10,
    host            : '165.132.104.207',  //origin server IP
    user            : 'root',
    password        : 'cclab',
    database        : 'origin'  //DB명도 surrogate말고 origin으로 바꾸는 게 좋을 듯.
    // multipleStatements : true,
    // waitForConnection : true,
    // connectionTimeout : 2000
});

module.exports = dbPool;
