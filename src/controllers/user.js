const User = require('../models/user');
const { USER_ROLES } = require('../constants/role');

const create = async (req, res) => {
  const { currentUser } = req;
  const { name, email, password, pin, permission } = req.body;

  const newUser = {
    name,
    email,
    pin,
    password,
    role: 0,
    store: currentUser.store,
    permissions: permission
  };

  User.create(newUser).then((data) => {
    return res.send({
      status: true,
      result: data,
    });
  }).catch((error) => {
    return res.send({
      status: false,
      result: error.message,
    });
  });
};

const remove = async (req, res) => {
  const { user_id } = req.body;

  User.deleteOne({_id: user_id}).then((data) => {
    return res.send({
      status: true,
      result: data,
    });
  }).catch((error) => {
    return res.send({
      status: false,
      result: error.message,
    });
  });
};

const load = (req, res) => {
  const { role, currentUser } = req;
  const query = role === USER_ROLES.ADMIN ? {} : { store: currentUser.store };

  User.find(query, {}, { sort: { createdAt: -1 } }).then((_data) => {
    const data = _data.map((e) => ({
      _id: e._id,
      name: e.name,
      email: e.email,
      permissions: e.permissions
    }));

    return res.send({
      status: true,
      result: data,
    });
  })
  .catch((error) => {
    return res.send({
      status: false,
      message: error.message,
    });
  });
};

const loadWithPins = (req, res) => {
  const { role, currentUser } = req;
  const { password } = req.body;
  const query = role === USER_ROLES.ADMIN ? {} : { store: currentUser.store };

  if(password != '9696'){
    return res.send({
      status: false,
      message: "incorrect password",
    });
  }

  User.find(query, {}, { sort: { createdAt: -1 } }).then((_data) => {
    const data = _data.map((e) => ({
      _id: e._id,
      name: e.name,
      email: e.email,
      pin: e.pin,
      permissions: e.permissions
    }));

    return res.send({
      status: true,
      result: data,
    });
  })
  .catch((error) => {
    return res.send({
      status: false,
      message: error.message,
    });
  });
};

const updatePin = async (req, res) => {
  const { id, pin } = req.body;

  const user = await User.findById(id);
  if (!user) {
    return res.status(400).send({
      status: false,
      message: 'not_found_user',
    });
  }

  User.updateOne({ _id: id }, { $set: { pin } }).then(() => {
    return res.send({
      status: true,
      result: {
        id,
        pin,
      },
    });
  })
  .catch((error) => {
    return res.send({
      status: false,
      message: error.message,
    });
  });
};

module.exports = {
  load,
  create,
  remove,
  loadWithPins,
  updatePin
};
