#include <iostream>
#include <string>
#include <vector>
#include <chrono>
#include <thread>
#include <atomic>
#include <csignal>
#include <cstring>

#include "zoom_sdk.h"
#include "auth_service_interface.h"
#include "meeting_service_interface.h"
#include "meeting_service_components/meeting_recording_interface.h"
#include "rawdata/zoom_rawdata_api.h"
#include "rawdata/rawdata_audio_helper_interface.h"

#include "audio_delegate.h"

USING_ZOOM_SDK_NAMESPACE

// Shutdown state management
std::atomic<bool> g_shutdown(false);
std::atomic<bool> g_meetingJoined(false);
std::atomic<bool> g_authSuccess(false);

void signalHandler(int signum) {
    std::cout << "\n[Bot] Received shutdown signal (" << signum << "). Initiating graceful exit..." << std::endl;
    g_shutdown = true;
}

// ==========================================
// Authentication Listener
// ==========================================
class ZoomAuthListener : public IAuthServiceEvent {
public:
    virtual void onAuthenticationReturn(AuthResult ret) override {
        std::cout << "[Auth Service] Callback: Authentication result code = " << ret << std::endl;
        if (ret == AUTHRET_SUCCESS) {
            std::cout << "[Auth Service] Authentication succeeded!" << std::endl;
            g_authSuccess = true;
        } else {
            std::cerr << "[Auth Service] Error: Authentication failed with code " << ret << std::endl;
            g_shutdown = true;
        }
    }

    virtual void onLoginReturnWithReason(LOGINSTATUS ret, IAccountInfo* pAccountInfo, LoginFailReason reason) override {}
    virtual void onLogout() override {}
    virtual void onZoomIdentityExpired() override {}
    virtual void onZoomAuthIdentityExpired() override {}
};

// ==========================================
// Recording Controller Listener
// ==========================================
class ZoomRecordingListener : public IMeetingRecordingCtrlEvent {
public:
    ZoomRecordingListener(ZoomAudioDelegate* audioDelegate, IZoomSDKAudioRawDataHelper* audioHelper, IMeetingRecordingController* recordingCtrl)
        : m_audioDelegate(audioDelegate), m_audioHelper(audioHelper), m_recordingCtrl(recordingCtrl), m_isSubscribed(false) {}

    virtual void onRecordingStatus(RecordingStatus status) override {
        std::cout << "[Recording Service] Status changed to: " << status << std::endl;
    }

    virtual void onCloudRecordingStatus(RecordingStatus status) override {}

    virtual void onRecordPrivilegeChanged(bool bCanRec) override {
        std::cout << "[Recording Service] Callback: Recording permission changed. CanRecord = " 
                  << (bCanRec ? "TRUE" : "FALSE") << std::endl;

        if (bCanRec) {
            std::cout << "[Recording Service] Recording permission has been GRANTED by the host!" << std::endl;
            StartRawRecordingAndSubscribe();
        } else {
            std::cout << "[Recording Service] Recording permission has been REVOKED or DENIED!" << std::endl;
            Unsubscribe();
        }
    }

    virtual void onLocalRecordingPrivilegeRequestStatus(RequestLocalRecordingStatus status) override {
        std::cout << "[Recording Service] Request status: ";
        if (status == RequestLocalRecording_Granted) {
            std::cout << "GRANTED" << std::endl;
        } else if (status == RequestLocalRecording_Denied) {
            std::cout << "DENIED" << std::endl;
            std::cerr << "[Recording Service] Error: The host denied the recording request." << std::endl;
        } else if (status == RequestLocalRecording_Timeout) {
            std::cout << "TIMEOUT" << std::endl;
            std::cerr << "[Recording Service] Error: Recording request timed out." << std::endl;
        } else {
            std::cout << "UNKNOWN" << std::endl;
        }
    }

    virtual void onLocalRecordingPrivilegeRequested(IRequestLocalRecordingPrivilegeHandler* handler) override {}
    virtual void onRequestCloudRecordingResponse(RequestStartCloudRecordingStatus status) override {}
    virtual void onStartCloudRecordingRequested(IRequestStartCloudRecordingHandler* handler) override {}
    virtual void onCloudRecordingStorageFull(time_t gracePeriodDate) override {}
    virtual void onEnableAndStartSmartRecordingRequested(IRequestEnableAndStartSmartRecordingHandler* handler) override {}
    virtual void onSmartRecordingEnableActionCallback(ISmartRecordingEnableActionHandler* handler) override {}
    virtual void onTranscodingStatusChanged(TranscodingStatus status, const zchar_t* path) override {}

    void StartRawRecordingAndSubscribe() {
        if (!m_isSubscribed) {
            // Trigger raw data recording state
            SDKError err = m_recordingCtrl->StartRawRecording();
            if (err == SDKERR_SUCCESS) {
                std::cout << "[Recording Service] Started rawdata recording state successfully." << std::endl;
            } else {
                std::cerr << "[Recording Service] StartRawRecording returned error code " << err << std::endl;
            }

            // Subscribe delegates to the audio helper
            std::cout << "[Audio Helper] Subscribing audio delegate to mixed raw audio stream..." << std::endl;
            err = m_audioHelper->subscribe(m_audioDelegate);
            if (err == SDKERR_SUCCESS) {
                m_isSubscribed = true;
                std::cout << "[Audio Helper] Audio delegate subscribed successfully!" << std::endl;
            } else {
                std::cerr << "[Audio Helper] Error: Subscribe failed with code " << err << std::endl;
            }
        }
    }

    void Unsubscribe() {
        if (m_isSubscribed) {
            m_audioHelper->unSubscribe();
            m_isSubscribed = false;
            std::cout << "[Audio Helper] Audio delegate unsubscribed successfully." << std::endl;
        }
    }

    bool IsSubscribed() const {
        return m_isSubscribed;
    }

private:
    ZoomAudioDelegate* m_audioDelegate;
    IZoomSDKAudioRawDataHelper* m_audioHelper;
    IMeetingRecordingController* m_recordingCtrl;
    bool m_isSubscribed;
};

// ==========================================
// Meeting Service Listener
// ==========================================
class ZoomMeetingListener : public IMeetingServiceEvent {
public:
    virtual void onMeetingStatusChanged(MeetingStatus status, int iResult = 0) override {
        std::cout << "[Meeting Service] Status changed to: ";
        switch (status) {
            case MEETING_STATUS_IDLE:
                std::cout << "IDLE" << std::endl;
                break;
            case MEETING_STATUS_CONNECTING:
                std::cout << "CONNECTING" << std::endl;
                break;
            case MEETING_STATUS_WAITINGFORHOST:
                std::cout << "WAITING FOR HOST" << std::endl;
                break;
            case MEETING_STATUS_INMEETING:
                std::cout << "IN MEETING" << std::endl;
                g_meetingJoined = true;
                break;
            case MEETING_STATUS_DISCONNECTING:
                std::cout << "DISCONNECTING" << std::endl;
                break;
            case MEETING_STATUS_ENDED:
                std::cout << "ENDED" << std::endl;
                g_shutdown = true;
                break;
            case MEETING_STATUS_FAILED:
                std::cout << "FAILED (Error code: " << iResult << ")" << std::endl;
                g_shutdown = true;
                break;
            default:
                std::cout << "UNKNOWN (" << status << ")" << std::endl;
        }
    }

    virtual void onMeetingParameterNotification(const MeetingParameter* meeting_param) override {}
    virtual void onMeetingStatisticsWarningNotification(StatisticsWarningType type) override {}
    virtual void onMeetingTopicChanged(const zchar_t* sTopic) override {}
    virtual void onSuspendParticipantsActivities() override {}
    virtual void onAICompanionActiveChangeNotice(bool bActive) override {}
    virtual void onMeetingFullToWatchLiveStream(const zchar_t* sLiveStreamUrl) override {}
    virtual void onUserNetworkStatusChanged(MeetingComponentType type, ConnectionQuality level, unsigned int userId, bool uplink) override {}
};

// ==========================================
// Main Entry Point
// ==========================================
int main(int argc, char* argv[]) {
    // Register signal handlers for graceful exit
    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);

    // Default arguments
    uint64_t meetingNumber = 0;
    std::string password = "";
    std::string jwtToken = "";
    std::string outputPath = "recording.wav";
    std::string botName = "Zoom Bot";

    // Parse command line arguments
    for (int i = 1; i < argc; i++) {
        if (std::strcmp(argv[i], "--meeting") == 0 && i + 1 < argc) {
            meetingNumber = std::stoull(argv[i + 1]);
            i++;
        } else if (std::strcmp(argv[i], "--password") == 0 && i + 1 < argc) {
            password = argv[i + 1];
            i++;
        } else if (std::strcmp(argv[i], "--jwt") == 0 && i + 1 < argc) {
            jwtToken = argv[i + 1];
            i++;
        } else if (std::strcmp(argv[i], "--output") == 0 && i + 1 < argc) {
            outputPath = argv[i + 1];
            i++;
        } else if (std::strcmp(argv[i], "--name") == 0 && i + 1 < argc) {
            botName = argv[i + 1];
            i++;
        }
    }

    if (meetingNumber == 0 || jwtToken.empty()) {
        std::cerr << "Usage: " << argv[0] << " --meeting <number> --jwt <token> [--password <pass>] [--output <path>] [--name <name>]" << std::endl;
        return 1;
    }

    std::cout << "[Bot] Starting up..." << std::endl;

    // 1. Initialize SDK
    InitParam initParam;
    initParam.strWebDomain = "https://zoom.us";
    initParam.strSupportUrl = "https://zoom.us";
    initParam.emLanguageID = LANGUAGE_English;
    initParam.enableLogByDefault = true;

    std::cout << "[Bot] Initializing Zoom Meeting SDK..." << std::endl;
    SDKError sdkErr = InitSDK(initParam);
    if (sdkErr != SDKERR_SUCCESS) {
        std::cerr << "[Bot] Error: SDK initialization failed with code " << sdkErr << std::endl;
        return 1;
    }
    std::cout << "[Bot] SDK initialized successfully." << std::endl;

    // 2. Authenticate SDK
    IAuthService* authService = nullptr;
    sdkErr = CreateAuthService(&authService);
    if (sdkErr != SDKERR_SUCCESS || !authService) {
        std::cerr << "[Bot] Error: Failed to create Auth Service." << std::endl;
        CleanUPSDK();
        return 1;
    }

    ZoomAuthListener authListener;
    authService->SetEvent(&authListener);

    AuthContext authContext;
    authContext.jwt_token = jwtToken.c_str();

    std::cout << "[Bot] Authenticating SDK using JWT..." << std::endl;
    sdkErr = authService->SDKAuth(authContext);
    if (sdkErr != SDKERR_SUCCESS) {
        std::cerr << "[Bot] Error: SDKAuth call failed with code " << sdkErr << std::endl;
        CleanUPSDK();
        return 1;
    }

    // Wait for authentication callback
    std::cout << "[Bot] Waiting for SDK authentication..." << std::endl;
    int waitCounter = 0;
    while (!g_authSuccess && !g_shutdown) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        if (++waitCounter > 50) { // 10 seconds timeout
            std::cerr << "[Bot] Error: SDK authentication timed out." << std::endl;
            CleanUPSDK();
            return 1;
        }
    }
    if (g_shutdown) {
        CleanUPSDK();
        return 0;
    }

    // 3. Create Meeting Service
    IMeetingService* meetingService = nullptr;
    sdkErr = CreateMeetingService(&meetingService);
    if (sdkErr != SDKERR_SUCCESS || !meetingService) {
        std::cerr << "[Bot] Error: Failed to create Meeting Service." << std::endl;
        CleanUPSDK();
        return 1;
    }

    ZoomMeetingListener meetingListener;
    meetingService->SetEvent(&meetingListener);

    // 4. Configure Join Parameters
    JoinParam joinParam;
    joinParam.userType = SDK_UT_WITHOUT_LOGIN;
    
    JoinParam4WithoutLogin& joinWithoutLogin = joinParam.param.withoutloginuserJoin;
    joinWithoutLogin.meetingNumber = meetingNumber;
    joinWithoutLogin.psw = password.c_str();
    joinWithoutLogin.userName = botName.c_str();
    joinWithoutLogin.isVideoOff = true;  // Headless bot does not send video
    joinWithoutLogin.isAudioOff = false; // Audio must be ON to record raw data

    std::cout << "[Bot] Joining meeting " << meetingNumber << " as '" << botName << "'..." << std::endl;
    sdkErr = meetingService->Join(joinParam);
    if (sdkErr != SDKERR_SUCCESS) {
        std::cerr << "[Bot] Error: Join call failed with code " << sdkErr << std::endl;
        CleanUPSDK();
        return 1;
    }

    // Wait for meeting join
    std::cout << "[Bot] Waiting to join the meeting..." << std::endl;
    waitCounter = 0;
    while (!g_meetingJoined && !g_shutdown) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        if (++waitCounter > 150) { // 30 seconds timeout
            std::cerr << "[Bot] Error: Joining meeting timed out." << std::endl;
            meetingService->Leave(LEAVE_MEETING);
            CleanUPSDK();
            return 1;
        }
    }
    if (g_shutdown) {
        meetingService->Leave(LEAVE_MEETING);
        CleanUPSDK();
        return 0;
    }

    std::cout << "[Bot] Successfully joined meeting! Configuring audio raw capture..." << std::endl;

    // 5. Initialize Raw Audio capture components
    ZoomAudioDelegate audioDelegate(outputPath);
    IZoomSDKAudioRawDataHelper* audioHelper = GetAudioRawdataHelper();
    if (!audioHelper) {
        std::cerr << "[Bot] Error: Failed to get Audio Rawdata Helper." << std::endl;
        meetingService->Leave(LEAVE_MEETING);
        CleanUPSDK();
        return 1;
    }

    IMeetingRecordingController* recordingCtrl = meetingService->GetMeetingRecordingController();
    if (!recordingCtrl) {
        std::cerr << "[Bot] Error: Failed to get Meeting Recording Controller." << std::endl;
        meetingService->Leave(LEAVE_MEETING);
        CleanUPSDK();
        return 1;
    }

    // Register recording event listener to detect permissions
    ZoomRecordingListener recordingListener(&audioDelegate, audioHelper, recordingCtrl);
    recordingCtrl->SetEvent(&recordingListener);

    // 6. Request/Verify recording privilege
    std::cout << "[Bot] Checking local recording privileges..." << std::endl;
    sdkErr = recordingCtrl->CanStartRawRecording();
    if (sdkErr == SDKERR_SUCCESS) {
        std::cout << "[Bot] Bot already has local recording privileges. Starting capture..." << std::endl;
        recordingListener.StartRawRecordingAndSubscribe();
    } else {
        std::cout << "[Bot] Bot does not have local recording privileges yet. Requesting from host..." << std::endl;
        sdkErr = recordingCtrl->RequestLocalRecordingPrivilege();
        if (sdkErr != SDKERR_SUCCESS) {
            std::cerr << "[Bot] Error: RequestLocalRecordingPrivilege failed with code " << sdkErr << std::endl;
        } else {
            std::cout << "[Bot] Local recording privilege request sent successfully to host." << std::endl;
        }
    }

    // 7. Keep process alive during recording
    std::cout << "[Bot] Main loop active. Press Ctrl+C to terminate and save the WAV recording." << std::endl;
    while (!g_shutdown) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    // 8. Graceful cleanup and exit
    std::cout << "[Bot] Cleaning up and exiting..." << std::endl;

    // Unsubscribe from audio streams
    recordingListener.Unsubscribe();

    // Disable recording event handler
    recordingCtrl->SetEvent(nullptr);

    // Stop raw recording
    recordingCtrl->StopRawRecording();

    // Leave the meeting
    if (meetingService->GetMeetingStatus() == MEETING_STATUS_INMEETING) {
        std::cout << "[Bot] Leaving the meeting..." << std::endl;
        meetingService->Leave(LEAVE_MEETING);
        // Wait a second for leave callback
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }

    // Shutdown SDK
    std::cout << "[Bot] Shutting down SDK..." << std::endl;
    CleanUPSDK();
    std::cout << "[Bot] Bot process finished." << std::endl;

    return 0;
}
