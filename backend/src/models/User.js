const mongoose = require('mongoose');

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const userSchema = new mongoose.Schema(
  {
    displayName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: emailPattern,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      enum: ['OWNER', 'OPERATOR', 'ANALYST'],
      default: 'OWNER',
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'SUSPENDED'],
      default: 'ACTIVE',
    },
  },
  {
    timestamps: true,
    strict: 'throw',
  },
);

userSchema.set('toJSON', {
  transform: (_document, returnedObject) => {
    delete returnedObject.passwordHash;
    return returnedObject;
  },
});

module.exports = mongoose.model('User', userSchema);
