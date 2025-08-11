const express = require('express');

const { load, create, remove, loadWithPins, updatePin } = require('../controllers/user');

const { catchError } = require('../middlewares/error');

const router = express.Router();

router.get('/', catchError(load));
router.post('/', catchError(loadWithPins));
router.post('/create', catchError(create));
router.post('/remove', catchError(remove));
router.post('/pin', catchError(updatePin));
module.exports = router;
