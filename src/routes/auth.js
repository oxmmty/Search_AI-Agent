const express = require('express');
const { login, loadMenus } = require('../controllers/auth');
const { catchError} = require('../middlewares/error');
const { checkAuth } = require('../middlewares/auth');

const router = express.Router();

router.post('/', catchError(login));
router.get('/check', checkAuth, (_, res) => {
    return res.send();
});
router.get('/menu', checkAuth, catchError(loadMenus));

module.exports = router;