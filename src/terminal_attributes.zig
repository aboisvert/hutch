const std = @import("std");
const builtin = @import("builtin");

// Zig 0.17's Linux std.c.termios aliases the kernel declaration (19 control
// characters on these targets). libc uses 32 and writes beyond that buffer.
// Keep both reads and writes on the libc ABI, including the speed fields.
const use_linux_libc = builtin.os.tag == .linux and builtin.link_libc and
    (builtin.cpu.arch == .aarch64 or builtin.cpu.arch == .x86_64);

pub const Termios = if (use_linux_libc) extern struct {
    iflag: @FieldType(std.posix.termios, "iflag"),
    oflag: @FieldType(std.posix.termios, "oflag"),
    cflag: @FieldType(std.posix.termios, "cflag"),
    lflag: @FieldType(std.posix.termios, "lflag"),
    line: u8,
    cc: [32]u8,
    ispeed: u32,
    ospeed: u32,
} else std.posix.termios;

const libc = struct {
    extern "c" fn tcgetattr(fd: c_int, term: *Termios) c_int;
    extern "c" fn tcsetattr(fd: c_int, action: std.posix.TCSA, term: *const Termios) c_int;
};

pub fn get(fd: std.posix.fd_t) std.posix.TermiosGetError!Termios {
    if (!use_linux_libc) return std.posix.tcgetattr(fd);
    var term: Termios = undefined;
    while (true) {
        switch (std.posix.errno(libc.tcgetattr(fd, &term))) {
            .SUCCESS => return term,
            .INTR => continue,
            .BADF => unreachable,
            .NOTTY => return error.NotATerminal,
            else => |err| return std.posix.unexpectedErrno(err),
        }
    }
}

pub fn set(fd: std.posix.fd_t, action: std.posix.TCSA, term: Termios) std.posix.TermiosSetError!void {
    if (!use_linux_libc) return std.posix.tcsetattr(fd, action, term);
    while (true) {
        switch (std.posix.errno(libc.tcsetattr(fd, action, &term))) {
            .SUCCESS => return,
            .INTR => continue,
            .BADF, .INVAL => unreachable,
            .NOTTY => return error.NotATerminal,
            .IO => return error.ProcessOrphaned,
            else => |err| return std.posix.unexpectedErrno(err),
        }
    }
}
