#include "audio_delegate.h"
#include <cstring>
#include <iomanip>

// ==========================================
// WavFileWriter Implementation
// ==========================================

WavFileWriter::WavFileWriter()
    : m_dataSize(0), m_sampleRate(0), m_numChannels(0), m_headerWritten(false) {}

WavFileWriter::~WavFileWriter() {
    Close();
}

bool WavFileWriter::Open(const std::string& path, uint32_t sampleRate, uint16_t numChannels) {
    m_path = path;
    m_sampleRate = sampleRate;
    m_numChannels = numChannels;
    m_dataSize = 0;
    m_headerWritten = false;

    m_file.open(m_path, std::ios::binary | std::ios::out);
    if (!m_file.is_open()) {
        std::cerr << "[WavFileWriter] Error: Failed to open output file " << m_path << std::endl;
        return false;
    }
    return true;
}

void WavFileWriter::Write(const char* data, uint32_t length) {
    if (!m_file.is_open()) return;

    if (!m_headerWritten) {
        WriteHeader(); // Write dummy header first
        m_headerWritten = true;
    }

    m_file.write(data, length);
    m_dataSize += length;
}

void WavFileWriter::WriteHeader() {
    WavHeader header;
    header.numChannels = m_numChannels;
    header.sampleRate = m_sampleRate;
    header.bitsPerSample = 16; // 16-bit PCM
    header.blockAlign = m_numChannels * (header.bitsPerSample / 8);
    header.byteRate = m_sampleRate * header.blockAlign;
    header.subChunk2Size = m_dataSize;
    header.chunkSize = 36 + m_dataSize;

    m_file.write(reinterpret_cast<const char*>(&header), sizeof(WavHeader));
}

void WavFileWriter::Close() {
    if (m_file.is_open()) {
        if (m_headerWritten) {
            // Seek back to start and overwrite header with final sizes
            m_file.seekp(0, std::ios::beg);
            WriteHeader();
            std::cout << "[WavFileWriter] Finalized WAV header: " << m_dataSize << " bytes written to " << m_path << std::endl;
        }
        m_file.close();
    }
}

// ==========================================
// ZoomAudioDelegate Implementation
// ==========================================

ZoomAudioDelegate::ZoomAudioDelegate(const std::string& outputPath)
    : m_outputPath(outputPath), m_isInitialized(false) {}

ZoomAudioDelegate::~ZoomAudioDelegate() {
    m_wavWriter.Close();
}

void ZoomAudioDelegate::onMixedAudioRawDataReceived(AudioRawData* data_) {
    if (!data_ || !data_->GetBuffer()) return;

    if (!m_isInitialized) {
        uint32_t sampleRate = data_->GetSampleRate();
        uint32_t channels = data_->GetChannelNum();
        
        std::cout << "[Audio Capture] First mixed audio frame received!" << std::endl;
        std::cout << "  - Sample Rate: " << sampleRate << " Hz" << std::endl;
        std::cout << "  - Channels: " << channels << std::endl;
        std::cout << "  - Output WAV: " << m_outputPath << std::endl;

        if (m_wavWriter.Open(m_outputPath, sampleRate, channels)) {
            m_isInitialized = true;
            std::cout << "[Audio Capture] Capturing raw audio in progress..." << std::endl;
        } else {
            std::cerr << "[Audio Capture] Error: Failed to initialize WAV writer." << std::endl;
            return;
        }
    }

    m_wavWriter.Write(data_->GetBuffer(), data_->GetBufferLen());
}

void ZoomAudioDelegate::onOneWayAudioRawDataReceived(AudioRawData* data_, uint32_t user_id) {
    // We only process mixed audio for the main recording goal.
}

void ZoomAudioDelegate::onShareAudioRawDataReceived(AudioRawData* data_, uint32_t user_id) {
    // Screen share audio - ignore for mixed audio recording.
}

void ZoomAudioDelegate::onOneWayInterpreterAudioRawDataReceived(AudioRawData* data_, const zchar_t* pLanguageName) {
    // Interpreter audio - ignore.
}
