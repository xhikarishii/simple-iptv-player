FROM node:18-alpine
RUN apk add --no-cache python3 make g++ ffmpeg
WORKDIR /app

# Copy files and install dependencies
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Run the Terser minification for production deployment
RUN npm run build

# Setup data directory and run
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["npm", "start"]