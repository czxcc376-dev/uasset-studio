package com.uassetstudio;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * McpHttpServer — 极简 HTTP/1.1 服务器，只用来把 MCP 的 JSON-RPC 请求转发给 WebView。
 *
 * 为什么不用第三方框架：APK 要保持体积、且只需支持 4 个路由（/mcp /health /tools /）。
 * 这里手写请求解析，够用且没有依赖。
 *
 * 线程模型：
 *   每个连接一个线程读请求 → 交给 handler（内部会 post 到 UI 线程执行 JS 并等待结果）
 *   → 写回响应。请求体上限 8MB，超时由 handler 控制。
 */
public class McpHttpServer {

    public interface Handler {
        /** 处理一次 JSON-RPC 请求，返回响应 JSON 字符串；返回 null 表示无需响应（通知） */
        String handle(String body) throws Exception;
    }

    private static final int MAX_BODY = 8 * 1024 * 1024;

    private final int port;
    private final boolean allowLan;
    private final Handler handler;
    private final String toolsJson;

    private ServerSocket serverSocket;
    private Thread acceptThread;
    private volatile boolean running;

    public McpHttpServer(int port, boolean allowLan, Handler handler, String toolsJson) {
        this.port = port;
        this.allowLan = allowLan;
        this.handler = handler;
        this.toolsJson = toolsJson == null ? "{\"tools\":[]}" : toolsJson;
    }

    public synchronized void start() throws IOException {
        if (running) return;
        InetAddress bind = allowLan ? InetAddress.getByName("0.0.0.0") : InetAddress.getByName("127.0.0.1");
        serverSocket = new ServerSocket(port, 16, bind);
        serverSocket.setReuseAddress(true);
        running = true;

        acceptThread = new Thread(() -> {
            while (running) {
                try {
                    final Socket socket = serverSocket.accept();
                    Thread t = new Thread(() -> serve(socket));
                    t.setDaemon(true);
                    t.start();
                } catch (IOException e) {
                    if (running) {
                        // accept 失败通常是端口被占用或 socket 被关闭
                        break;
                    }
                }
            }
        }, "mcp-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    public synchronized void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) { }
        serverSocket = null;
        if (acceptThread != null) acceptThread.interrupt();
        acceptThread = null;
    }

    public synchronized boolean isRunning() {
        return running;
    }

    public int getPort() {
        return port;
    }

    public boolean isAllowLan() {
        return allowLan;
    }

    /* ------------------------------------------------------------------ 连接处理 */

    private void serve(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(30000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;

            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                writeJson(out, 400, "{\"error\":\"bad request line\"}");
                return;
            }
            String method = parts[0].toUpperCase(Locale.ROOT);
            String path = parts[1].split("\\?")[0];

            // 读头
            int contentLength = 0;
            String header;
            while ((header = readLine(in)) != null && !header.isEmpty()) {
                int idx = header.indexOf(':');
                if (idx > 0) {
                    String name = header.substring(0, idx).trim().toLowerCase(Locale.ROOT);
                    String value = header.substring(idx + 1).trim();
                    if (name.equals("content-length")) {
                        try { contentLength = Integer.parseInt(value); } catch (NumberFormatException ignored) { }
                    }
                }
            }

            if ("OPTIONS".equals(method)) {
                writeCors(out, 204, "");
                return;
            }
            if ("GET".equals(method) && "/health".equals(path)) {
                writeJson(out, 200, "{\"ok\":true,\"name\":\"uasset-studio-app\",\"transport\":\"http\",\"lan\":" + allowLan + "}");
                return;
            }
            if ("GET".equals(method) && "/tools".equals(path)) {
                writeJson(out, 200, toolsJson);
                return;
            }
            if ("POST".equals(method) && ("/mcp".equals(path) || "/".equals(path))) {
                if (contentLength <= 0) {
                    writeJson(out, 411, "{\"error\":\"length required\"}");
                    return;
                }
                if (contentLength > MAX_BODY) {
                    writeJson(out, 413, "{\"error\":\"body too large\"}");
                    return;
                }
                byte[] body = readExactly(in, contentLength);
                if (body == null) {
                    writeJson(out, 400, "{\"error\":\"incomplete body\"}");
                    return;
                }
                String text = new String(body, StandardCharsets.UTF_8);
                String response;
                try {
                    response = handler.handle(text);
                } catch (Exception e) {
                    response = "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":"
                            + quote(String.valueOf(e.getMessage())) + "}}";
                }
                if (response == null) {
                    writeCors(out, 202, "");
                } else {
                    writeJson(out, 200, response);
                }
                return;
            }
            writeJson(out, 404, "{\"error\":\"not found\",\"endpoints\":[\"POST /mcp\",\"GET /health\",\"GET /tools\"]}");
        } catch (Exception e) {
            // 单个连接出错不影响服务
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(128);
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') buf.write(c);
            if (buf.size() > 8192) break;
        }
        if (c == -1 && buf.size() == 0) return null;
        return new String(buf.toByteArray(), StandardCharsets.US_ASCII);
    }

    private static byte[] readExactly(InputStream in, int length) throws IOException {
        byte[] out = new byte[length];
        int read = 0;
        while (read < length) {
            int n = in.read(out, read, length - read);
            if (n <= 0) return null;
            read += n;
        }
        return out;
    }

    private static void writeJson(OutputStream out, int code, String body) throws IOException {
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + code + " " + statusText(code) + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + payload.length + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Methods: POST, GET, OPTIONS\r\n"
                + "Access-Control-Allow-Headers: content-type, mcp-session-id, authorization\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        out.write(payload);
        out.flush();
    }

    private static void writeCors(OutputStream out, int code, String body) throws IOException {
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + code + " " + statusText(code) + "\r\n"
                + "Content-Length: " + payload.length + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Methods: POST, GET, OPTIONS\r\n"
                + "Access-Control-Allow-Headers: content-type, mcp-session-id, authorization\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        out.write(payload);
        out.flush();
    }

    private static String statusText(int code) {
        switch (code) {
            case 200: return "OK";
            case 202: return "Accepted";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 404: return "Not Found";
            case 411: return "Length Required";
            case 413: return "Payload Too Large";
            default: return "Status";
        }
    }

    private static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }
}
