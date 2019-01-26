FROM node:10.15.0

EXPOSE 8080

ADD . .
RUN yarn install --pure-lockfile

CMD yarn start
