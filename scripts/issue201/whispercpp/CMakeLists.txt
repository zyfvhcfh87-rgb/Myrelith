# Reviewable recipe only; configure/build are separately gated.
cmake_minimum_required(VERSION 4.4)
project(myrelith_speech_candidate C CXX)
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Only the reviewed Emscripten toolchain is permitted")
endif()
if(NOT DEFINED WHISPER_SOURCE_DIR)
    message(FATAL_ERROR "Provide the hash-verified and patched source directory")
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
set(CMAKE_C_FLAGS_RELEASE "-O3 -DNDEBUG -msimd128 -fexceptions")
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG -msimd128 -fexceptions")
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(WHISPER_BUILD_COMMIT "371b5a7561823ab2bb32142d2751e35e7534727b-myrelith-budget1")
set(WHISPER_BUILD_NUMBER 4938)
set(GGML_BUILD_COMMIT "371b5a7561823ab2bb32142d2751e35e7534727b-myrelith-build1")
set(GGML_GIT_DIRTY 0)
set(WHISPER_WASM_PTHREADS OFF CACHE BOOL "" FORCE)
set(GGML_WASM_SINGLE_THREAD ON CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(GGML_CPU ON CACHE BOOL "" FORCE)
foreach(feature WHISPER_BUILD_TESTS WHISPER_BUILD_EXAMPLES WHISPER_BUILD_SERVER
    WHISPER_CURL WHISPER_SDL2 WHISPER_COREML WHISPER_COREML_ALLOW_FALLBACK
    WHISPER_OPENVINO WHISPER_USE_SYSTEM_GGML WHISPER_USE_SYSTEM_LLAMA
    GGML_BUILD_TESTS GGML_BUILD_EXAMPLES GGML_BACKEND_DL GGML_CPU_ALL_VARIANTS
    GGML_CCACHE GGML_NATIVE GGML_LTO GGML_OPENMP GGML_ACCELERATE GGML_BLAS
    GGML_LLAMAFILE GGML_CPU_REPACK GGML_CPU_HBM GGML_CPU_KLEIDIAI
    GGML_CUDA GGML_HIP GGML_MUSA GGML_VULKAN GGML_WEBGPU GGML_METAL
    GGML_RPC GGML_SYCL GGML_OPENVINO GGML_OPENCL GGML_HEXAGON GGML_ZENDNN
    GGML_ZDNN GGML_VIRTGPU GGML_VIRTGPU_BACKEND GGML_ET GGML_ET_SYSEMU GGML_CANN)
    set(${feature} OFF CACHE BOOL "" FORCE)
endforeach()
configure_file(myrelith-token-budget.h "${WHISPER_SOURCE_DIR}/src/myrelith-token-budget.h" COPYONLY)
add_subdirectory("${WHISPER_SOURCE_DIR}" whisper-core)
add_executable(myrelith-whisper adapter.cpp)
target_link_libraries(myrelith-whisper PRIVATE whisper)
set_target_properties(myrelith-whisper PROPERTIES SUFFIX ".mjs")
target_link_options(myrelith-whisper PRIVATE
    "-msimd128" "-fexceptions" "--no-entry"
    "-sDISABLE_EXCEPTION_CATCHING=0" "-sABORTING_MALLOC=0"
    "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sEXPORT_NAME=createMyrelithWhisper"
    "-sENVIRONMENT=worker" "-sFILESYSTEM=0" "-sDYNAMIC_EXECUTION=0"
    "-sCROSS_ORIGIN_STORAGE=0" "-sCROSS_ORIGIN=0" "-sSPLIT_MODULE=0"
    "-sMAIN_MODULE=0" "-sSIDE_MODULE=0" "-sAUTOLOAD_DYLIBS=0"
    "-sWASM=1" "-sSINGLE_FILE=0" "-sSOURCE_PHASE_IMPORTS=0" "-sWASM_ESM_INTEGRATION=0"
    "-sWASM_ASYNC_COMPILATION=1" "-sWASM_WORKERS=0" "-sPROXY_TO_PTHREAD=0"
    "-sFETCH=0" "-sWASMFS=0" "-sALLOW_TABLE_GROWTH=0"
    # PTHREADS is internal in the pinned SDK: no -pthread/OpenMP inputs enable it.
    # Generated WASM must still prove one defined, unshared, bounded memory.
    "-sALLOW_MEMORY_GROWTH=1" "-sIMPORTED_MEMORY=0"
    "-sINITIAL_MEMORY=67108864" "-sMAXIMUM_MEMORY=536870912"
    "-sMEMORY_GROWTH_GEOMETRIC_STEP=0" "-sMEMORY_GROWTH_LINEAR_STEP=16777216"
    "-sSTACK_SIZE=5242880" "-sEXIT_RUNTIME=0" "-sMALLOC=dlmalloc"
    "-sINCOMING_MODULE_JS_API=['wasmBinary','locateFile','print','printErr','onAbort']"
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPF32']"
    "-sEXPORTED_FUNCTIONS=['_speech_model_alloc','_speech_load','_speech_pcm_alloc','_speech_run','_speech_tokens','_speech_segment_count','_speech_segment_t0','_speech_segment_t1','_speech_segment_text','_speech_close','_speech_owned']")
