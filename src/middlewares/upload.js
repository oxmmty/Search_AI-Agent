const { S3Client } = require('@aws-sdk/client-s3')
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { v4: uuidv4 } = require('uuid');
const { AWS_S3_CLIENT_ID, AWS_S3_SECRET_KEY, AWS_BUCKET } = require('../configs/key');

const s3 = new S3Client({
  credentials: {
    accessKeyId: AWS_S3_CLIENT_ID,
    secretAccessKey: AWS_S3_SECRET_KEY
  },
  region: 'us-west-2'
});

const createUploader = (folder) => {
  return multer({
    storage: multerS3({
      s3,
      bucket: AWS_BUCKET,
      acl: 'public-read',
      metadata: (req, file, cb) => {
        cb(null, { fieldName: file.fieldName })
      },
      contentType: (req, file, cb) => {
        cb(null, file.mimetype)
      },
      key: (req, file, cb) => {
        const fileName = Date.now() + '-' + uuidv4() + path.extname(file.originalname);
        cb(
          null,
          folder + '/' +  fileName
        )
      }
    })
  })
}

module.exports = createUploader;