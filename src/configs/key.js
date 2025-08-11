const ENV = {
    JWT_SECRET_KEY: 'jwt_secret_of_instacoin',
    AWS_S3_CLIENT_ID: process.env.AWS_S3_CLIENT_ID,
    AWS_S3_SECRET_KEY: process.env.AWS_S3_SECRET_KEY,
    AWS_BUCKET: process.env.AWS_BUCKET,
    AWS_SES_CLIENT_ID: process.env.AWS_SES_CLIENT_ID,
    AWS_SES_SECRET_KEY: process.env.AWS_SES_SECRET_KEY,
}

module.exports = ENV;