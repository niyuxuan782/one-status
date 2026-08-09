class OneStatus < Formula
  desc "Manage AI tools, models, Persona, and work state across devices"
  homepage "https://github.com/niyuxuan782/one-status"
  url "https://github.com/niyuxuan782/one-status/releases/download/v0.7.0/one-status-0.7.0.tgz"
  sha256 "56c9b4795effc04cfabc5a90ae81f6bf2b062425fb0a7c29b0d662e1b882600b"
  license all_of: ["Apache-2.0", "MIT"]

  depends_on "node"

  on_macos do
    on_arm do
      resource "device-sidecar" do
        url "https://github.com/niyuxuan782/one-status/releases/download/v0.7.0/one-status-device-sidecar-0.7.0-mac-arm64.tar.gz"
        sha256 "0aebd332343451f59857a0f2d0576baca1606ad9f25b06ce395a615a4969a61d"
      end
    end
    on_intel do
      resource "device-sidecar" do
        url "https://github.com/niyuxuan782/one-status/releases/download/v0.7.0/one-status-device-sidecar-0.7.0-mac-x64.tar.gz"
        sha256 "49fd7ce299280ad726cc51c8a2d4d2539098afe9f85c4d57e8990f27aaff05a3"
      end
    end
  end

  on_linux do
    depends_on arch: :x86_64
    resource "device-sidecar" do
      url "https://github.com/niyuxuan782/one-status/releases/download/v0.7.0/one-status-device-sidecar-0.7.0-linux-x64.tar.gz"
      sha256 "693bea9187f4815a317501b5144e1ce52f33e798094a4f08669d15c6abb427d7"
    end
  end

  def install
    libexec.install "dist/one-status.js"
    chmod 0755, libexec/"one-status.js"
    bin.install_symlink libexec/"one-status.js" => "one-status"
    pkgshare.install "LICENSE", "dist/THIRD_PARTY_NOTICES.txt"

    resource("device-sidecar").stage do
      libexec.install "one-status-device-sidecar"
      chmod 0755, libexec/"one-status-device-sidecar"
      bin.install_symlink libexec/"one-status-device-sidecar"
      pkgshare.install "THIRD_PARTY_NOTICES.device-sidecar.md"
      (pkgshare/"licenses/cc-switch").install "licenses/cc-switch/LICENSE"
    end

    (var/"one-status").mkpath
    chmod 0700, var/"one-status"
  end

  service do
    run [opt_bin/"one-status", "server", "--host", "127.0.0.1", "--port", "8787",
         "--db", var/"one-status/one-status.sqlite"]
    environment_variables ONE_STATUS_DEVICE_SIDECAR: (opt_libexec/"one-status-device-sidecar").to_s
    keep_alive true
    working_dir var/"one-status"
    log_path var/"log/one-status.log"
    error_log_path var/"log/one-status.error.log"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/one-status version").strip
    assert_match "one-status mcp --transport http", shell_output("#{bin}/one-status help")
    assert_predicate libexec/"one-status-device-sidecar", :executable?
    assert_match '"ok":true', pipe_output("#{libexec}/one-status-device-sidecar scan", "{}")
  end
end
