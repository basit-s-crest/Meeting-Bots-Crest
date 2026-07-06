#!/bin/bash
# Exit on error
set -e

echo "Setting up PulseAudio virtual sound card for headless environment..."

# Start D-Bus if not running (often required for PulseAudio in headless Linux)
if [ ! -d /var/run/dbus ]; then
    echo "Creating dbus run directory..."
    sudo mkdir -p /var/run/dbus
    sudo dbus-uuidgen --ensure
    sudo dbus-daemon --system --fork || true
fi

# Cleanup old PulseAudio files to avoid startup lock issues
echo "Cleaning up PulseAudio state..."
rm -rf /var/run/pulse /var/lib/pulse /root/.config/pulse ~/.config/pulse || true

# Start PulseAudio daemon as a non-system user process
# --exit-idle-time=-1 prevents the daemon from shutting down when idle
echo "Starting PulseAudio daemon..."
pulseaudio -D --exit-idle-time=-1 || pulseaudio --start --exit-idle-time=-1

# Wait for PulseAudio to initialize
sleep 2

# Create Virtual Speaker (SpeakerOutput)
echo "Creating SpeakerOutput virtual audio device..."
pactl load-module module-null-sink sink_name=SpeakerOutput sink_properties=device.description=SpeakerOutput || echo "SpeakerOutput sink already loaded"

# Set default sink to the virtual speaker
pactl set-default-sink SpeakerOutput

# Create Zoom configuration file directory if it doesn't exist
mkdir -p ~/.config
ZOOM_CONF_PATH="$HOME/.config/zoomus.conf"

# Write general audio settings to zoomus.conf
echo "Writing Zoom audio configuration to ${ZOOM_CONF_PATH}..."
cat <<EOT > "${ZOOM_CONF_PATH}"
[General]
system.audio.type=default
EOT

echo "PulseAudio virtual sound card setup completed successfully."
pactl list short sinks
