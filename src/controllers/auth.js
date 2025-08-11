const jwt = require('jsonwebtoken');
const User = require('../models/user');
const { JWT_SECRET_KEY } = require('../configs/key');
const { USER_MENU_ITEMS } = require('../constants/menu');

const login = async (req, res) => {
    const { email, password } = req.body;
    let user = await User.findOne({ email }).catch((err) => {
        return res.status(400).send({
            status: false,
            message: err.message || 'DB ERROR'
        })
    });
    if (!user) {
        return res.status(400).send({
            status: false,
            message: "Incorrect email address"
        })
    }else if (user.password !== password) {
        return res.status(400).send({
            status: false,
            message: 'Invalid Password'
        })
    }

    const payload = {
        id: user._id
    };
    const token = jwt.sign(payload, JWT_SECRET_KEY);
    return res.send({
        status: true,
        result: {
            token,
            username: user.name,
            role: user.role,
            timezone: user.timezone
        }
    });
}

const loadMenus = async (req, res) => {
    return res.send({
        status: true,
        result: USER_MENU_ITEMS
    });
}


module.exports = {
    login,
    loadMenus
}