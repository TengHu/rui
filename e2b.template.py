#!/usr/bin/env python3
"""
E2B template for a general AI agent with a lightweight virtual desktop stack.
"""

from e2b import Template, default_build_logger


template = (
    Template()
    .from_template("code-interpreter-v1")
    .apt_install(
        [
            "python3",
            "python3-pip",
            "python3-venv",
            "git",
            "curl",
            "wget",
            "unzip",
            "xz-utils",
            "ca-certificates",
            "jq",
            "tmux",
            # Lightweight GUI tooling for a virtual computer
            "xvfb",
            "x11vnc",
            "fluxbox",
            "xterm",
            "dbus-x11",
            "xdotool",
        ]
    )
    # Install Node.js 20 LTS - download and install binary directly
    .run_cmd("curl -fsSL https://nodejs.org/dist/v20.11.0/node-v20.11.0-linux-x64.tar.gz -o /tmp/node.tar.gz")
    .run_cmd("tar -xzf /tmp/node.tar.gz -C /tmp")
    .run_cmd("cp -r /tmp/node-v20.11.0-linux-x64/* /usr/local/")
    .run_cmd("rm -rf /tmp/node.tar.gz /tmp/node-v20.11.0-linux-x64")
    .run_cmd("useradd -m -s /bin/bash user || true")
    .run_cmd("mkdir -p /home/user/workspace && chown -R user:user /home/user/workspace")
    .set_workdir("/home/user/workspace")
    .set_user("user")
)


if __name__ == "__main__":
    Template.build(
        template,
        alias="general-ai-agent",
        cpu_count=2,
        memory_mb=2048,
        on_build_logs=default_build_logger(min_level="info"),
    )
