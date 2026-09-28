# VietNote Desktop

VietNote là trợ lý ghi chép và tóm tắt cuộc họp theo thời gian thực dành cho macOS và Windows. Ứng dụng có thể nghe microphone, âm thanh hệ thống hoặc cả hai nguồn; nhận diện tiếng Việt, tiếng Anh và tiếng Trung; sau đó tạo bản ghi, bản dịch tiếng Việt và bản tóm tắt có cấu trúc.

Dự án sử dụng **Tauri + React + TypeScript** cho ứng dụng desktop, **Rust** cho phần tích hợp hệ điều hành và gọi dịch vụ AI, cùng một worker **Python** để xử lý nhận diện giọng nói và tổng hợp tiếng nói.

## Tính năng chính

- Thu âm từ **microphone**, **âm thanh hệ thống** hoặc **cả hai**. Nguồn mặc định là cả hai.
- Nhận diện giọng nói tiếng Việt, tiếng Anh và tiếng Trung theo thời gian thực.
- Dịch trực tiếp tiếng Anh và tiếng Trung sang tiếng Việt bằng **Gemini 3.5 Live Translate**, gồm chữ và âm thanh tiếng Việt độ trễ thấp.
- Tự động dùng dịch theo đoạn qua API local/Groq khi backend nhận diện không phải Gemini.
- Tóm tắt trực tiếp theo số từ hoặc khoảng thời gian do người dùng lựa chọn.
- Hiển thị riêng:
  - **Tổng quan cuộc họp** được cập nhật tích lũy.
  - **Nội dung mới nhất** của phần vừa xử lý.
- Phân loại kết quả thành ý chính, quyết định cuối cùng, quyết định tạm thời, vấn đề chưa chốt, việc cần làm, câu hỏi mở và nội dung hoãn lại.
- Liên kết các nội dung quan trọng với đoạn transcript làm bằng chứng.
- Lưu và quản lý ghi chú cuộc họp trên máy.
- Hỗ trợ giao diện sáng, tối hoặc tự động theo hệ thống.
- Cho phép lựa chọn **9Router** hoặc **Groq** để dịch và tóm tắt.

## Kiến trúc dự án

```text
src/            Giao diện React và luồng nghiệp vụ của ứng dụng
src-tauri/      Backend Rust, thu âm native, lưu dữ liệu và gọi API AI
asr/            Worker Python cho ASR, VAD và TTS
scripts/        Script cài đặt, chạy, build và chấm acceptance test
tests/          Unit test, smoke test và kịch bản acceptance test
voices/         Tài nguyên giọng đọc tiếng Việt
```

Luồng xử lý chính:

```text
Microphone / âm thanh hệ thống
→ stream PCM 16 kHz trực tiếp tới Gemini Live (hoặc chia đoạn bằng VAD cho backend cũ)
→ nhận transcript tạm thời và transcript hoàn tất
→ chuẩn hóa thuật ngữ có kiểm soát
→ transcript có ID và thời gian ổn định
→ Gemini Live dịch thẳng Anh/Trung → Việt; backend khác dùng dịch theo đoạn
→ tóm tắt cuộc họp có cấu trúc
→ kiểm tra dẫn chứng và liên kết về transcript
→ lưu ghi chú cuối cùng từ toàn bộ transcript
```

## Yêu cầu môi trường

### macOS

- Máy Mac Apple Silicon.
- macOS 15 trở lên.
- Homebrew.
- Node.js và npm.
- Rust cùng Cargo.
- Python 3.12; script bootstrap có thể cài bằng Homebrew nếu máy chưa có.

Ứng dụng cần quyền **Microphone** để thu tiếng nói và quyền **Screen & System Audio Recording** để lấy âm thanh hệ thống.

### Windows

- Windows 10 hoặc 11.
- Node.js LTS.
- Rust với MSVC toolchain.
- Python 3.12 cùng Python Launcher (`py`).
- WebView2 và công cụ build C++ cần thiết cho Tauri.

## Cài đặt và chạy trên macOS

```bash
git clone <repository-url>
cd mac-live-translator

./scripts/bootstrap.sh
TASK_CARGO_BIN="$HOME/.cargo/bin" ./scripts/dev-tauri.sh
```

`bootstrap.sh` tạo môi trường Python tại `.venv`, cài dependency ASR, và cài package npm.

Nếu cần `ffmpeg` để chuyển đổi các định dạng âm thanh phục vụ debug:

```bash
INSTALL_FFMPEG=1 ./scripts/bootstrap.sh
```

## Build ứng dụng macOS

```bash
TASK_CARGO_BIN="$HOME/.cargo/bin" ./scripts/build-tauri.sh
```

Ứng dụng sau khi build nằm tại:

```text
src-tauri/target/release/bundle/macos/VietNote.app
```

## Cài đặt và build trên Windows

Mở PowerShell trong thư mục dự án và chạy:

```powershell
.\scripts\bootstrap-windows.ps1
```

Script sẽ tạo `.venv`, cài dependency Python và npm, sau đó build ứng dụng bằng Tauri.

## Bộ cài phát hành qua GitHub Actions

Workflow [build-installers.yml](.github/workflows/build-installers.yml) tạo hai artifact: DMG cho macOS Apple Silicon và EXE NSIS cho Windows x64. Chạy thủ công từ tab Actions hoặc đẩy tag `v*`; tag sẽ tạo GitHub Release và thay toàn bộ asset cũ của tag đó bằng hai bộ cài mới.

Repository cần có secret `VIETNOTE_GROQ_API_KEY` trước khi chạy. Workflow nhúng key này khi biên dịch, không lưu key trong mã nguồn. Hãy đưa `vendor/cpal/` và cả hai tệp ZIP trong `voices/` vào commit phát hành; workflow kiểm tra các tài nguyên này trước khi build.

Bản phát hành đóng gói worker Python cho API nhận diện và ZeroTTS, không cần model nhận diện cục bộ. Model ZeroTTS được tải và lưu vào cache khi chạy lần đầu. DMG hiện ký ad hoc; muốn người dùng macOS mở trực tiếp mà không gặp cảnh báo Gatekeeper cần thêm chứng chỉ Developer ID và notarization.

## Cấu hình nhận diện giọng nói

VietNote hỗ trợ hai chế độ ASR, cả hai đều cần API key:

- **Gemini Live (ưu tiên):** stream PCM 16-bit trực tiếp tới `gemini-3.5-transcribe-live`, hiển thị interim transcript và tự nối phiên trước giới hạn 10 phút.
- **Groq:** dùng `whisper-large-v3` qua API tương thích OpenAI khi có `GROQ_API_KEY`.

Trong bản phát hành, key miễn phí được nhúng lúc build từ GitHub Secret. Mục **Nhập Key** trong giao diện dành cho key VietNote nâng hạn mức về sau, không thay đổi key API dịch vụ.

Cũng có thể cung cấp key bằng biến môi trường trước khi chạy ứng dụng:

```bash
export GEMINI_API_KEY="..."
TASK_CARGO_BIN="$HOME/.cargo/bin" ./scripts/dev-tauri.sh
```

Bạn cũng có thể nhập Gemini API key tại **Cài đặt → Gemini 3.5 Transcribe + Live Translate**. Key được lưu trong Keychain/Credential Manager; frontend không đọc được giá trị key.

Các biến môi trường tùy chọn:

| Biến | Giá trị | Mặc định | Mô tả |
| --- | --- | --- | --- |
| `ASR_BACKEND` | `groq`, `gemini`, `auto` | `auto` | Chọn backend; `auto` ưu tiên Gemini, rồi Groq |
| `GEMINI_API_KEY` | API key Google AI | trống | Bật Gemini Live khi backend là `auto` hoặc `gemini` |
| `GEMINI_ASR_MODEL` | Tên model Gemini | `gemini-3.5-transcribe-live` | Model Live Transcription cho tiếng Việt |
| `GEMINI_LIVE_TRANSLATE_MODEL` | Tên model Gemini | `gemini-3.5-live-translate-preview` | Dịch realtime Anh/Trung → Việt |
| `GROQ_ASR_MODEL` | Tên model Groq | `whisper-large-v3` | Model dùng cho ASR Groq |
| `GROQ_BASE_URL` | URL API | API chính thức của Groq | Ghi đè endpoint Groq |
| `VIETNOTE_PYTHON` | Đường dẫn Python | Python trong `.venv` | Ghi đè Python chạy worker |

Không đưa API key vào mã nguồn hoặc commit lên repository.

## Cấu hình dịch và tóm tắt AI

VietNote cho phép chọn nhà cung cấp tại **Cài đặt → Tóm tắt & dịch AI**.

### 9Router

Cấu hình mặc định:

```text
Base URL: http://127.0.0.1:20128/v1
Model:    cx/gpt-5.5
```

Endpoint, model ID và API key đều có thể thay đổi trong ứng dụng. Nếu server local không yêu cầu xác thực thì API key là tùy chọn. Key cũng có thể được cung cấp qua `NINE_ROUTER_API_KEY`.

VietNote không cài hoặc chọn sẵn Qwen/Ollama cho dịch và tóm tắt. Các cấu hình cũ dùng model Qwen được tự động chuyển về API local mặc định ở trên.

### Groq

Groq sử dụng model `openai/gpt-oss-120b` cho dịch và tóm tắt. Cùng một Groq key được dùng cho ASR mà không đưa key ra phía React.

Khi thay đổi API key, worker ASR sẽ được khởi động lại. Hãy dừng phiên ghi âm trước khi đổi key hoặc cấu hình nhà cung cấp.

## Cách sử dụng

1. Mở **Cài đặt** và chọn nhà cung cấp AI phù hợp.
2. Tại **Trang chủ**, chọn nguồn âm thanh:
   - Âm thanh máy
   - Microphone
   - Microphone + âm thanh máy
3. Chọn ngôn ngữ cuộc họp:
   - Tiếng Việt
   - Tiếng Anh → Tiếng Việt
   - Tiếng Trung → Tiếng Việt
4. Chọn nhịp cập nhật tóm tắt theo số từ hoặc số phút.
5. Nhấn **Bắt đầu tóm tắt** và cấp quyền hệ thống khi được yêu cầu.
6. Theo dõi transcript, bản dịch Gemini Live, tổng quan cuộc họp và nội dung mới nhất.
7. Nhấn **Kết thúc & lưu** để tạo ghi chú từ toàn bộ transcript.

## Cách VietNote tạo bản tóm tắt

Bản tóm tắt có cấu trúc tách riêng:

- Tóm tắt ngắn toàn cuộc họp.
- Ý chính.
- Quyết định cuối cùng.
- Quyết định tạm thời.
- Chủ đề đang thảo luận nhưng chưa có quyết định cuối cùng.
- Việc cần làm, người phụ trách và thời hạn nếu được nói rõ.
- Câu hỏi còn mở.
- Nội dung được hoãn sang thời điểm khác.

Các quyết định, việc cần làm và nội dung quan trọng phải tham chiếu ID thực tế của transcript. ID không hợp lệ sẽ bị loại bỏ; nội dung quan trọng không có bằng chứng cũng không được giữ lại. Khi kết thúc cuộc họp, ghi chú cuối cùng được tạo lại từ toàn bộ transcript thay vì chỉ ghép các bản tóm tắt tạm thời.

## Lưu trữ dữ liệu

Ghi chú được lưu trong thư mục dữ liệu ứng dụng của Tauri trên máy người dùng. Các ghi chú ở định dạng cũ vẫn có thể đọc được; ghi chú mới lưu thêm bản tóm tắt có cấu trúc và danh sách đoạn transcript.

VietNote hiện không lưu file âm thanh gốc. Các liên kết bằng chứng sẽ chuyển đến và làm nổi bật đoạn transcript tương ứng.

## Kiểm thử

Chạy unit test frontend, kiểm tra build và test Python:

```bash
npm test
npm run build
.venv/bin/python -m unittest discover -s tests -v
```

Kiểm tra Rust:

```bash
cd src-tauri
cargo test
cargo check
```

### Acceptance test 20 câu

Đọc các câu VN01–VN20 trong `tests/VietNote_ACCEPTANCE_TESTS.md` vào VietNote, ghi kết quả theo định dạng yêu cầu rồi chấm bằng:

```bash
python3 scripts/score_vietnote_acceptance.py /duong-dan-tuyet-doi/toi/results.json
```

Danh sách câu kiểm thử nằm trong `tests/vietnote_acceptance_cases.json`. Tiêu chí và ngưỡng đạt MVP được mô tả trong `tests/VietNote_ACCEPTANCE_TESTS.md`.

### Debug ASR với file WAV

File đầu vào cần là WAV mono, PCM16, 16 kHz:

```bash
./scripts/debug.sh /duong-dan-tuyet-doi/toi/input.wav
```

## Nhận diện người nói bằng Nemotron 3

Gemini tiếp tục nhận dạng/dịch; Nemotron 3 nhận cùng audio mono 16 kHz và chạy
streaming trên máy để gán `Người nói 1`, `Người nói 2`… cho transcript.
Microphone và System có bộ nhớ người nói riêng; cùng số thứ tự ở hai nguồn
không chứng minh đó là cùng một người.

Cài một lần trên Mac Apple Silicon (sau bootstrap):

```bash
bash scripts/setup-diarization.sh
bash scripts/dev-tauri.sh
```

Script build runtime C của [NVIDIA NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp)
tại commit cố định, tải model Nemotron 3 Q8 khoảng 103 MiB và xác minh SHA-256.
Model/runtime nằm trong `.cache/`, không được commit. Build cần Homebrew,
SentencePiece, Abseil và Xcode Command Line Tools; CMake/Ninja được cài vào `.venv`.
Lần nạp Metal đầu tiên có thể chậm do biên dịch kernel.

Trong **Cài đặt → Nhận diện người nói · Nemotron 3**, icon xanh xuất hiện khi
runtime đã nạp đúng model 8 người nói. Không cần API key cho diarization.
Model sử dụng buffer 0,64 giây; thời gian inference và ghép transcript cộng thêm
vào độ trễ này. Nhãn tạm có thể được cập nhật, và được hoàn tất trước khi lưu
ghi chú khi dừng. Nếu model thiếu hoặc lỗi, transcript Gemini vẫn hoạt động.

Các biến môi trường tùy chọn:

- `DIARIZATION_BACKEND=off`: tắt diarization.
- `NEMOTRON_DEVICE=cpu`: dùng CPU thay GPU.
- `NEMOTRON_LIBRARY`: đường dẫn tuyệt đối tới thư viện C native.
- `NEMOTRON_MODEL`: đường dẫn tuyệt đối tới Nemotron 3 GGUF.

App không tự đọc `.env`; export biến trước khi chạy app. Máy khác hoặc bản
đóng gói cần cài runtime/model riêng và cấu hình đường dẫn tương ứng; script
hiện tự động hóa Apple Silicon. Chưa đóng gói model vào installer.

Ghép speaker hiện ở **cấp đoạn**, dựa trên timeline audio và biên câu Gemini
ước lượng, chưa có căn chỉnh từng từ. Đoạn chứa nhiều giọng có thể hiện nhiều
nhãn; không suy đoán tên thật hoặc người phụ trách từ số người nói.

Kiểm tra adapter và luồng cập nhật/flush:

```bash
.venv/bin/python -m unittest tests/test_diarization.py tests/test_gemini_live.py
```

## Giới hạn hiện tại

- Ứng dụng chưa lưu âm thanh gốc nên không thể phát lại âm thanh từ liên kết bằng chứng.
- Nhận diện người nói tối đa 8 người mỗi nguồn; độ chính xác giảm khi giọng chồng nhau, câu ngắn hoặc nhiều tiếng ồn. Chưa benchmark chất lượng tiếng Việt trên bộ dữ liệu có nhãn.
- Người phụ trách chỉ được gán khi tên người đó xuất hiện rõ trong transcript.
- Chuẩn hóa thuật ngữ được thực hiện thận trọng để tránh làm sai nội dung gốc.
- Âm thanh hệ thống có DRM có thể không được API của hệ điều hành cung cấp.
- Hiệu năng và độ trễ của model local phụ thuộc vào cấu hình máy.
- Khi dùng 9Router local, dịch vụ API và model tương ứng phải được khởi động riêng.
- Khi dùng Groq, chất lượng và khả năng hoạt động phụ thuộc vào kết nối mạng, quota và chính sách của nhà cung cấp.
