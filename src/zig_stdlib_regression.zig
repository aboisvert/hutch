const std = @import("std");
const builtin = @import("builtin");
const String = @import("package_manager/support/semver/string.zig").String;

extern "c" fn hutch_test_termios_abi() [*]const usize;
extern "c" fn hutch_test_open_terminal(master: *c_int) c_int;
extern "c" fn hutch_test_close_terminal(fd: c_int) void;

test "Linux libc termios ABI matches the terminal attributes buffer" {
    if (builtin.os.tag != .linux or !builtin.link_libc) return error.SkipZigTest;

    // tcgetattr writes libc's struct into our terminal attributes buffer. An undersized
    // buffer corrupts the stack before the picker can render. Check the ABI
    // without a TTY, so piped CI runs cannot silently bypass this regression.
    const Termios = @import("terminal_attributes.zig").Termios;
    const actual = [_]usize{
        @sizeOf(Termios),
        @alignOf(Termios),
        @offsetOf(Termios, "iflag"),
        @offsetOf(Termios, "oflag"),
        @offsetOf(Termios, "cflag"),
        @offsetOf(Termios, "lflag"),
        @offsetOf(Termios, "line"),
        @offsetOf(Termios, "cc"),
        @sizeOf(@FieldType(Termios, "cc")),
        @offsetOf(Termios, "ispeed"),
        @offsetOf(Termios, "ospeed"),
    };
    const expected = hutch_test_termios_abi()[0..actual.len];
    try std.testing.expectEqualSlices(usize, expected, &actual);
}

test "Linux terminal attributes enter raw mode and restore on a private PTY" {
    if (builtin.os.tag != .linux or !builtin.link_libc) return error.SkipZigTest;
    const attributes = @import("terminal_attributes.zig");
    var master: c_int = -1;
    const slave = hutch_test_open_terminal(&master);
    try std.testing.expect(slave >= 0);
    defer hutch_test_close_terminal(master);
    defer hutch_test_close_terminal(slave);

    const saved = try attributes.get(slave);
    defer attributes.set(slave, .NOW, saved) catch {};
    var raw = saved;
    raw.lflag.ICANON = false;
    raw.lflag.ECHO = false;
    raw.lflag.ISIG = false;
    raw.lflag.IEXTEN = false;
    raw.cc[@backingInt(std.posix.V.MIN)] = 1;
    raw.cc[@backingInt(std.posix.V.TIME)] = 0;
    try attributes.set(slave, .NOW, raw);
    try std.testing.expectEqualDeep(raw, try attributes.get(slave));

    try attributes.set(slave, .NOW, saved);
    try std.testing.expectEqualDeep(saved, try attributes.get(slave));
}

// Keep the package-cache naming tests in the standard release test run too.
comptime {
    _ = @import("package_manager/support/util/package_cache.zig");
}

test "semver strings retain their persisted eight-byte representation" {
    const buffer = "prefix:long-prerelease-identifier";
    const external = String.init(buffer, buffer[7..]);
    try std.testing.expect(!external.isInline());
    // Existing lockfiles encode native little-endian offset/length words,
    // with the high bit marking a reference into the shared string buffer.
    const persisted = [_]u8{ 7, 0, 0, 0, 26, 0, 0, 0x80 };
    try std.testing.expectEqualSlices(u8, &persisted, std.mem.asBytes(&external));
    const restored = std.mem.bytesToValue(String, &persisted);
    try std.testing.expectEqual(@as(usize, 26), restored.len());
    try std.testing.expectEqualStrings(buffer[7..], restored.slice(buffer));

    const ascii = "12345678";
    for (0..ascii.len + 1) |len| {
        const value = String.init(ascii, ascii[0..len]);
        try std.testing.expect(value.isInline());
        try std.testing.expectEqual(len, value.len());
        try std.testing.expectEqualStrings(ascii[0..len], value.slice(ascii));
    }

    // Eight bytes ending in a non-ASCII byte must use the external form;
    // otherwise the inline payload could be mistaken for the reference tag.
    const unicode = "abcdefé";
    const value = String.init(unicode, unicode);
    try std.testing.expect(!value.isInline());
    try std.testing.expectEqualStrings(unicode, value.slice(unicode));
}
