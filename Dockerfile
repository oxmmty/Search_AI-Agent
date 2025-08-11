# FROM ubuntu:18.04

# RUN apt-get update && apt-get install -y libc6 openssh-server curl dirmngr apt-transport-https lsb-release ca-certificates ffmpeg gcc g++ make
# RUN DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC apt-get -y install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev libvips-dev 
# # SSH Setting
# # RUN mkdir /var/run/sshd
# # RUN echo 'root:THEPASSWORDYOUCREATED' | chpasswd
# # RUN sed -i 's/PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config

# # SSH login fix. Otherwise user is kicked off after login
# # RUN sed 's@session\s*required\s*pam_loginuid.so@session optional pam_loginuid.so@g' -i /etc/pam.d/sshd

# # ENV NOTVISIBLE "in users profile"
# # RUN echo "export VISIBLE=now" >> /etc/profile

# # SHELL ["/bin/bash", "--login", "-i", "-c"]

# # # Grab Node12
# # RUN curl --silent -o- https://raw.githubusercontent.com/creationix/nvm/master/install.sh |  bash -

# # RUN source /root/.bashrc
# # RUN nvm -v
# # RUN nvm install 18.12.1


# # #do Node stuff
# # RUN mkdir -p /home/node/app/node_modules 
# # # this was removed && chown -R node:node /home/node/app

# # WORKDIR /home/node/app

# # COPY  ./ ./

# # RUN node -v && npm -v
# # RUN npm install

# # EXPOSE 3000 22
# # # CMD ["./dockerCMD.sh"] test
# # CMD /usr/sbin/sshd && npm run start

# # # USER node
# # SHELL ["/bin/bash", "--login", "-c"]

# RUN mkdir -p /usr/local/nvm
# ENV NVM_DIR /usr/local/nvm
# ENV NODE_VERSION v18.12.1
# RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash
# RUN /bin/bash -c "source $NVM_DIR/nvm.sh && nvm use --delete-prefix $NODE_VERSION && npm -v && nvm -v && node -v"
# ENV NODE_PATH $NVM_DIR/versions/node/$NODE_VERSION/bin
# ENV PATH $NODE_PATH:$PATH

# FROM debian:latest

# ENV NODE_ENV=production
# WORKDIR /
# COPY package.json package.json

# RUN apt-get update
# # RUN apt-get -y install build-essential
# # RUN DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC apt-get -y --assume-yes install libcairo2-dev
# # RUN apt-get -y install libpango1.0-dev
# # RUN apt-get -y install libjpeg-dev
# # RUN apt-get -y install libgif-dev
# # RUN apt-get -y install librsvg2-dev
# # RUN apt-get -y install libvips-dev
# RUN apt-get install -y curl

# RUN apt-get -y autoclean

# # nvm environment variables
# ENV NVM_DIR /usr/local/nvm
# ENV NODE_VERSION 18.12.1

# RUN mkdir $NVM_DIR

# # install nvm
# # https://github.com/creationix/nvm#install-script
# RUN curl --silent -o- https://raw.githubusercontent.com/creationix/nvm/v0.39.2/install.sh | bash

# # install node and npm
# RUN echo "source $NVM_DIR/nvm.sh \
#     && nvm install $NODE_VERSION \
#     && nvm alias default $NODE_VERSION \
#     && nvm use default" | bash

# # add node and npm to path so the commands are available
# ENV NODE_PATH $NVM_DIR/v$NODE_VERSION/lib/node_modules
# ENV PATH $NVM_DIR/versions/node/v$NODE_VERSION/bin:$PATH

# # confirm installation
# RUN node -v
# RUN npm -v

# COPY ./ ./

# RUN npm install

# EXPOSE 3001
# CMD [ "node", "./sharp/install/libvips.js" ]

###########################################Origianl Docker####################
# FROM ubuntu:16.04

# RUN apt-get update && apt-get install -y openssh-server curl dirmngr apt-transport-https lsb-release ca-certificates ffmpeg gcc g++ make
# RUN mkdir /var/run/sshd
# RUN echo 'root:THEPASSWORDYOUCREATED' | chpasswd
# RUN sed -i 's/PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config

# # SSH login fix. Otherwise user is kicked off after login
# RUN sed 's@session\s*required\s*pam_loginuid.so@session optional pam_loginuid.so@g' -i /etc/pam.d/sshd

# ENV NOTVISIBLE "in users profile"
# RUN echo "export VISIBLE=now" >> /etc/profile

# # Grab Node12
# RUN curl -sL https://deb.nodesource.com/setup_12.x |  bash -
# RUN apt -y install nodejs

# #do Node stuff
# RUN mkdir -p /home/node/app/node_modules 
# # this was removed && chown -R node:node /home/node/app

# WORKDIR /home/node/app

# COPY  . .

# # USER node

# RUN npm install



# EXPOSE 3000 22
# # CMD ["./dockerCMD.sh"] test
# CMD /usr/sbin/sshd && npm run start

FROM node:18

RUN apt-get update
RUN apt-get install -y libc6 openssh-server curl dirmngr apt-transport-https lsb-release ca-certificates ffmpeg gcc g++ make
RUN DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC apt-get -y install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev libvips-dev 

RUN node -v
RUN npm -v

WORKDIR /home/node/app

COPY  ./ ./
RUN npm install -g node-gyp
RUN yarn install
# RUN node ./sharp/install/libvips.js

EXPOSE 3000

CMD ["node", "./bins/www.js"]