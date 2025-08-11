const mongoose = require('mongoose');

const Schema = mongoose.Schema;

const UserSchema = new Schema(
  {
    name: String,
    email: String,
    password: String,
    timezone: { type: String, default: 'America/New_York' },
    role: { type: Number, enum: [0, 1, 2, 3, 4], default: 0 }
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  }
);

const User = mongoose.model('user', UserSchema);

module.exports = User;
