const express = require('express');
const { getData } = require('../controllers/dashboard');
const {catchError} = require('../middlewares/error');

const router = express.Router();

router.post('/data', catchError(getData));

module.exports = router;