#ifndef AUDIO_DELEGATE_H
#define AUDIO_DELEGATE_H

#include <iostream>
#include <fstream>
#include <string>
#include <cstdint>
#include "rawdata/rawdata_audio_helper_interface.h"
#include "zoom_sdk_def.h"

USING_ZOOM_SDK_NAMESPACE

// Standard WAV file header structure
struct WavHeader {
    char chunkId[4] = {'R', 'I', 'F', 'F'};
    uint32_t chunkSize = 0;        // 36 + subChunk2Size
    char format[4] = {'W', 'A', 'V', 'E'};
    char subChunk1Id[4] = {'f', 'm', 't', ' '};
    uint32_t subChunk1Size = 16;
    uint16_t audioFormat = 1;      // 1 = uncompressed PCM
    uint16_t numChannels = 1;      // 1 = Mono, 2 = Stereo
    uint32_t sampleRate = 32000;   // Dynamic from SDK
    uint32_t byteRate = 64000;     // sampleRate * numChannels * bitsPerSample/8
    uint16_t blockAlign = 2;       // numChannels * bitsPerSample/8
    uint16_t bitsPerSample = 16;   // 16-bit depth
    char subChunk2Id[4] = {'d', 'a', 't', 'a'};
    uint32_t subChunk2Size = 0;    // Total size of raw PCM samples in bytes
};

// Helper class to handle WAV file creation, writing, and header finalization
class WavFileWriter {
public:
    WavFileWriter();
    ~WavFileWriter();
    bool Open(const std::string& path, uint32_t sampleRate, uint16_t numChannels);
    void Write(const char* data, uint32_t length);
    void Close();

private:
    std::ofstream m_file;
    std::string m_path;
    uint32_t m_dataSize;
    uint32_t m_sampleRate;
    uint16_t m_numChannels;
    bool m_headerWritten;

    void WriteHeader();
};

// Zoom SDK Raw Audio Delegate
class ZoomAudioDelegate : public IZoomSDKAudioRawDataDelegate {
public:
    ZoomAudioDelegate(const std::string& outputPath);
    virtual ~ZoomAudioDelegate();

    // IZoomSDKAudioRawDataDelegate implementations
    virtual void onMixedAudioRawDataReceived(AudioRawData* data_) override;
    virtual void onOneWayAudioRawDataReceived(AudioRawData* data_, uint32_t user_id) override;
    virtual void onShareAudioRawDataReceived(AudioRawData* data_, uint32_t user_id) override;
    virtual void onOneWayInterpreterAudioRawDataReceived(AudioRawData* data_, const zchar_t* pLanguageName) override;

private:
    std::string m_outputPath;
    WavFileWriter m_wavWriter;
    bool m_isInitialized;
};

#endif // AUDIO_DELEGATE_H
