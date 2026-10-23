const std = @import("std");
const builtin = @import("builtin");

pub fn replace(
    allocator: std.mem.Allocator,
    executable: []const u8,
    argv: []const []const u8,
    environment: *const std.process.Environ.Map,
) !void {
    if (comptime builtin.os.tag == .windows) {
        return error.ProcessReplacementUnsupported;
    }

    const argv_z = try allocator.allocSentinel(?[*:0]const u8, argv.len, null);
    for (argv, 0..) |argument, index| {
        argv_z[index] = (try allocator.dupeSentinel(u8, argument, 0)).ptr;
    }
    const environment_block = try environment.createPosixBlock(allocator, .{});

    if (std.mem.indexOfScalar(u8, executable, '/') != null) {
        const executable_z = try allocator.dupeSentinel(u8, executable, 0);
        return std.Io.Threaded.posixExecveat(std.posix.AT.FDCWD, executable_z.ptr, argv_z.ptr, environment_block);
    }

    // A matching system toolchain is represented by its command name ("bun").
    // execve itself never searches PATH. Resolve it using the environment we
    // are handing off, preserving argv[0] and the existing inheritable leases.
    // Keep direct execve: macOS spawn-based replacement can close descriptors
    // that the launcher/engine deliberately made inheritable.
    if (executable.len == 0) return error.FileNotFound;
    const search_path = environment.get("PATH") orelse std.Io.Threaded.default_PATH;
    var directories = std.mem.splitScalar(u8, search_path, ':');
    var access_denied = false;
    while (directories.next()) |directory| {
        // POSIX empty PATH components denote the current working directory.
        const candidate = try std.fs.path.join(allocator, &.{
            if (directory.len == 0) "." else directory,
            executable,
        });
        defer allocator.free(candidate);
        const candidate_z = try allocator.dupeSentinel(u8, candidate, 0);
        defer allocator.free(candidate_z);
        switch (std.Io.Threaded.posixExecveat(std.posix.AT.FDCWD, candidate_z.ptr, argv_z.ptr, environment_block)) {
            error.FileNotFound, error.NotDir => continue,
            error.AccessDenied => {
                access_denied = true;
                continue;
            },
            else => |err| return err,
        }
    }
    return if (access_denied) error.AccessDenied else error.FileNotFound;
}
