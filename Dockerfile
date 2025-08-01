# Gunakan image node resmi
FROM node:20-slim

# Set direktori kerja di dalam container
WORKDIR /app

# Salin file package.json dan package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Salin seluruh project ke dalam container
COPY . .

# Jalankan aplikasi saat container start
CMD [ "node", "index.js" ]

# Expose port yang digunakan oleh Express
EXPOSE 3000
