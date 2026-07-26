FROM node:20-bullseye

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        git \
        locales \
        libcurl4-openssl-dev \
        libssl-dev \
        pkg-config \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/* && \
    sed -i 's/^# \(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen && \
    locale-gen en_US.UTF-8

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV LANGUAGE=en_US.UTF-8

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . ./

RUN npm run build-simc

EXPOSE 3000
CMD ["npm", "start"]
