const jwt = require('jsonwebtoken');
const User = require('../models/user');
const { JWT_SECRET_KEY } = require('../configs/key')

const checkJwtNext = async (decoded, req, res, next) => {
    if (!decoded.id) {
        return res.status(401).send({
            status: false,
            message: 'invalid_authorization'
        })
    }
    const user = await User.findById(decoded.id);
    if (!user) {
        return res.status(401).send({
            status: false,
            message: 'not_found_user'
        })
    }
    req.currentUser = {
        ...user._doc,
        password: undefined
    };
    req.role = user.role;
    next();
};

const checkAuthWithoutExpiration = async (req, res, next) => {
    const token = req.get('Authorization');
    if (!token) {
        return res.status(401).send({
            status: false,
            message: 'invalid_request'
        })
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET_KEY);
        await checkJwtNext(decoded, req, res, next);
        return;
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            try {
                const decoded = jwt.decode(token);
                await checkJwtNext(decoded, req, res, next);
                return;
            } catch (err) {
                return res.status(401).send({
                    status: false,
                });
            }
        } else {
            return res.status(401).send({
                status: false,
            });
        }
    }
}

const checkAuth = async (req, res, next) => {
    const token = req.get('Authorization');
    if (!token) {
        return res.status(401).send({
            status: false,
            message: 'invalid_request'
        })
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET_KEY);
        await checkJwtNext(decoded, req, res, next);
        return;
    } catch (err) {
        return res.status(401).send({
            status: false,
            err: err.message
        });
    }
}

const checkAdminFeature = (req, res, next) => {
    const { role } = req;
    if (role !== 2) {
        return;
    }
    next();
}


module.exports = {
    checkAuth,
    checkAdminFeature,
    checkAuthWithoutExpiration
}