FROM node:20-bullseye

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . ./

RUN npm run build-simc

EXPOSE 3000
CMD ["npm", "start"]
