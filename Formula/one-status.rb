class OneStatus < Formula
  desc "Portable identity, context, memory, and permission layer for AI agents"
  homepage "https://github.com/niyuxuan782/one-status"
  url "https://github.com/niyuxuan782/one-status/releases/download/v0.2.0/one-status-0.2.0.tgz"
  sha256 "6abb9a0e034a9a4d798d42050062b612c431895974a5b4d8f7a7b16dfcdb18e5"
  license "Apache-2.0"

  depends_on "node"

  def install
    libexec.install "dist/one-status.js"
    chmod 0755, libexec/"one-status.js"
    bin.install_symlink libexec/"one-status.js" => "one-status"
    pkgshare.install "LICENSE", "dist/THIRD_PARTY_NOTICES.txt"
    (var/"one-status").mkpath
    chmod 0700, var/"one-status"
  end

  service do
    run [opt_bin/"one-status", "server", "--host", "127.0.0.1", "--port", "8787",
         "--db", var/"one-status/one-status.sqlite"]
    keep_alive true
    working_dir var/"one-status"
    log_path var/"log/one-status.log"
    error_log_path var/"log/one-status.error.log"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/one-status version").strip
    assert_match "one-status mcp --transport http", shell_output("#{bin}/one-status help")
  end
end
