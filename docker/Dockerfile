FROM node:20.12.2-alpine3.19
RUN mkdir -p /server
COPY ./expo-updates-server /server
WORKDIR /server
RUN rm -rf /server/node_modules
RUN rm -rf /server/.next
# will be overwrote by docker's hostname => move to docker-compose
RUN rm -rf /server/.env.local
RUN yarn install --frozen-lockfile
RUN yarn build

EXPOSE 3000

CMD ["sh", "-c", "yarn dockerstart"]