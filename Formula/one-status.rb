class OneStatus < Formula
  desc "Portable identity, context, memory, and permission layer for AI agents"
  homepage "https://github.com/niyuxuan782/one-status"
  url "https://github.com/niyuxuan782/one-status/releases/download/v0.4.0/one-status-0.4.0.tgz"
  sha256 "a56beeae4e8e5b9b7c3abd1f35d0ee6f2d8441bd1cd796c7ccfa06857319ba72"
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
