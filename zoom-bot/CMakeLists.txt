cmake_minimum_required(VERSION 3.10)
project(zoomBot CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Configure output directories
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR})

# SDK Directories
set(SDK_INCLUDE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/lib/zoomsdk/h)
set(SDK_LIB_DIR ${CMAKE_CURRENT_SOURCE_DIR}/lib/zoomsdk)

# Verification: Check if SDK headers exist
if(NOT EXISTS ${SDK_INCLUDE_DIR}/zoom_sdk.h)
    message(FATAL_ERROR "Zoom SDK headers not found in: ${SDK_INCLUDE_DIR}. Please make sure you have extracted the SDK.")
endif()

# Include directories
include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${SDK_INCLUDE_DIR}
    ${SDK_INCLUDE_DIR}/rawdata
)

# Source files
set(SOURCES
    src/main.cpp
    src/audio_delegate.cpp
)

# Headers
set(HEADERS
    src/audio_delegate.h
)

# Link directories
link_directories(${SDK_LIB_DIR})

# Executable target
add_executable(zoomBot ${SOURCES} ${HEADERS})

# Compile options
target_compile_options(zoomBot PRIVATE -Wall -Wextra)

# Link Meeting SDK and pthread libraries
target_link_libraries(zoomBot
    meetingsdk
    pthread
)

# Configure rpath so that compiled binary can locate libmeetingsdk.so
# when executing from the workspace dir
set_target_properties(zoomBot PROPERTIES
    BUILD_WITH_INSTALL_RPATH TRUE
    INSTALL_RPATH "${SDK_LIB_DIR}"
)

message(STATUS "Configured zoomBot target. Link path: ${SDK_LIB_DIR}")
