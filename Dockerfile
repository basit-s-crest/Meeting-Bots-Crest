FROM mcr.microsoft.com/playwright:v1.45.0-jammy

# Set working directory
WORKDIR /app

# Copy dependency configs
COPY package*.json ./
COPY "Google Meet/package*.json" "./Google Meet/"
COPY "dashboard/backend/package*.json" "./dashboard/backend/"

# Install root & project-specific dependencies
RUN npm install
RUN cd "Google Meet" && npm install
RUN cd "dashboard/backend" && npm install

# Install real Google Chrome channel dependencies inside the image
RUN npx playwright install chrome

# Copy the rest of the application files
COPY . .

# Expose the public Space port (7860) and internal websocket ports
EXPOSE 7860
EXPOSE 8090-8100

# Set environment variables
ENV HEADLESS=true
ENV PORT=7860

# Start the central dashboard server
CMD ["node", "dashboard/backend/server.js"]
