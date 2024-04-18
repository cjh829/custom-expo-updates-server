# EXPO CUSTOM UPDATE SERVER - docker版

## (1) 準備環境

### 1. 在server適當位置，clone這個repo

```shell
git clone git@github.com:cjh829/custom-expo-updates-server.git
```

### 2. 把開發提供的加密key，放到 docker/code-signing-keys 目錄內
會提供兩個文件
1. private-key.pem
2. public-key.pem

### 3. 配置公開域名，編輯 docker/docker-compose.yml
```yaml
    environment:
      HOSTNAME: "http://192.168.0.138:3000" # <---這裡把公開域名填入，不用帶3000 port
      PRIVATE_KEY_PATH: "/server/code-signing-keys/private-key.pem" # <---這行不用動
```

## (2) 啟動服務
### === 以下都在根目錄執行(注意!!!不是在docker目錄) ===

### 1. 建構 docker 影像
```shell
docker build --no-cache -t expo_update_server . -f docker/Dockerfile
```

### 2. 用 docker-compose 啟動 docker 容器 
```shell
docker-compose -f ./docker/docker-compose.yml up -d
```

### 3. 配置 nginx 代理轉發
服務會起在 3000 port ，配置 nginx 綁定域名代理轉發，就完成了服務上線的動作

## (3) 發布更新
### 更新文件，需要傳送到 docker/updates 目錄內，資料結構為
```javascript
`docker/updates/${runtimeVersion}/${時間戳}/${dist目錄內容}`
```
### 需要架FTP服務配置到這個目錄，讓jenkins能上傳熱更文件
