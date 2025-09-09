const express = require('express');
const { checkAuth } = require('../middlewares/auth');
const auth = require('./auth');
const user = require('./user');
const dashboard = require('./dashboard');

const router = express.Router();
// App api
router.use('/auth', auth);
router.use('/user', checkAuth, user);
router.use('/dashboard', checkAuth, dashboard);

router.get('/', (req, res) => {
  res.send('app is running');
});

module.exports = router;
