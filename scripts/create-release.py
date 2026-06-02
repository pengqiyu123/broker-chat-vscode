import json, os, urllib.request, sys

token = os.environ.get("GH_TOKEN", "").strip()
if not token:
    print("ERROR: no token")
    sys.exit(1)

repo = sys.argv[1] if len(sys.argv) > 1 else "pengqiyu123/broker-chat-vscode"

body = json.dumps({
    "tag_name": "v0.0.2",
    "target_commitish": "main",
    "name": "v0.0.2 - Auto-Forward Engine",
    "body": "## v0.0.2 更新内容\n\n### 新增：关键词自动转发\n- AutoForwardEngine：检测用户消息关键词，自动转发模型最终回复\n- 支持关键词变体\n- Claude end_turn + Codex 稳定轮询完成检测\n- 复用手动按钮同款格式\n\n### 新增：顶部 UI 重设计\n- 双行分层布局 + 设置面板 + Toggle\n\n### 删除：MCP Server 和 HTTP API\n\n### 安装\n下载 VSIX，VS Code Extensions -> Install from VSIX...",
    "draft": False,
    "prerelease": False
}).encode()

req = urllib.request.Request(
    f"https://api.github.com/repos/{repo}/releases",
    data=body,
    headers={"Authorization": "token " + token, "Content-Type": "application/json", "User-Agent": "broker-release-script"},
    method="POST"
)

try:
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read())
    release_id = data["id"]
    html_url = data["html_url"]
    print(f"RELEASE_ID={release_id}")
    print(html_url)

    # Upload VSIX asset
    vsix_path = os.path.join(os.path.dirname(__file__), "..", "artifacts", "broker-chat-vscode-0.0.2.vsix")
    vsix_path = os.path.normpath(vsix_path)
    if os.path.exists(vsix_path):
        with open(vsix_path, "rb") as f:
            vsix_data = f.read()
        upload_req = urllib.request.Request(
            f"https://uploads.github.com/repos/{repo}/releases/{release_id}/assets?name=broker-chat-vscode-0.0.2.vsix",
            data=vsix_data,
            headers={"Authorization": "token " + token, "Content-Type": "application/octet-stream", "User-Agent": "broker-release-script"},
            method="POST"
        )
        upload_resp = urllib.request.urlopen(upload_req)
        upload_data = json.loads(upload_resp.read())
        print(f"ASSET_UPLOADED={upload_data.get('name', 'unknown')}")
    else:
        print(f"WARNING: VSIX not found at {vsix_path}")
except urllib.error.HTTPError as e:
    error_body = json.loads(e.read())
    print(f"ERROR: {e.code} {error_body.get('message', 'unknown')}")
    sys.exit(1)
