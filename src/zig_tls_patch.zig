//! Applies the same authenticated TLS policy to Hutch's managed compiler as the
//! one used to build Hutch. System Zig is never modified.
const std = @import("std");

pub const version = "0.17.0";
const manifest = @embedFile("zig_tls_patch.json");
const File = struct {
    path: []const u8,
    pristineSha256: []const u8,
    patchedSha256: []const u8,
    edits: []const struct { before: []const u8, after: []const u8 },
};
const Manifest = struct { files: []const File };

fn hashMatches(source: []const u8, expected: []const u8) bool {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(source, &digest, .{});
    return std.mem.eql(u8, &std.fmt.bytesToHex(digest, .lower), expected);
}

/// Caller holds the managed toolchain installation lock. Files may be either
/// pristine or patched so an interrupted upgrade is safe to retry offline.
pub fn apply(io: std.Io, allocator: std.mem.Allocator, root: []const u8) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const parsed = try std.json.parseFromSlice(Manifest, a, manifest, .{ .ignore_unknown_fields = true });
    const Write = struct { path: []const u8, bytes: []const u8 };
    var writes: std.ArrayList(Write) = .empty;
    for (parsed.value.files) |file| {
        const file_path = try std.fs.path.join(a, &.{ root, file.path });
        const raw = try std.Io.Dir.cwd().readFileAlloc(io, file_path, a, .limited(1024 * 1024));
        var source = try std.mem.replaceOwned(u8, a, raw, "\r\n", "\n");
        if (hashMatches(source, file.patchedSha256)) {
            if (!std.mem.eql(u8, raw, source)) try writes.append(a, .{ .path = file_path, .bytes = source });
            continue;
        }
        if (!hashMatches(source, file.pristineSha256)) return error.ZigTlsSourceDrift;
        for (file.edits) |edit| {
            if (std.mem.count(u8, source, edit.before) != 1) return error.ZigTlsPatchAmbiguous;
            source = try std.mem.replaceOwned(u8, a, source, edit.before, edit.after);
        }
        if (!hashMatches(source, file.patchedSha256)) return error.ZigTlsPatchHashMismatch;
        try writes.append(a, .{ .path = file_path, .bytes = source });
    }
    for (writes.items) |write| {
        const temporary = try std.mem.concat(a, u8, &.{ write.path, ".hutch-tls-tmp" });
        try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = temporary, .data = write.bytes });
        try std.Io.Dir.cwd().rename(temporary, std.Io.Dir.cwd(), write.path, io);
    }
}

test "managed Zig TLS policy patches pristine and cached installs and rejects drift" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const io = std.testing.io;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const root = try std.fs.path.join(a, &.{ ".zig-cache", "tmp", &temporary.sub_path });
    const parsed = try std.json.parseFromSlice(Manifest, a, manifest, .{ .ignore_unknown_fields = true });
    for (parsed.value.files) |file| {
        const vendored_path = try std.fs.path.join(a, &.{ "vendors", "zig", file.path });
        var source = try std.Io.Dir.cwd().readFileAlloc(io, vendored_path, a, .limited(1024 * 1024));
        try std.testing.expect(hashMatches(source, file.patchedSha256));
        var index = file.edits.len;
        while (index > 0) {
            index -= 1;
            const edit = file.edits[index];
            source = try std.mem.replaceOwned(u8, a, source, edit.after, edit.before);
        }
        try std.testing.expect(hashMatches(source, file.pristineSha256));
        const target = try std.fs.path.join(a, &.{ root, file.path });
        try std.Io.Dir.cwd().createDirPath(io, std.fs.path.dirname(target).?);
        try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = target, .data = source });
    }
    try apply(io, a, root);
    try apply(io, a, root);
    for (parsed.value.files) |file| {
        const target = try std.fs.path.join(a, &.{ root, file.path });
        const source = try std.Io.Dir.cwd().readFileAlloc(io, target, a, .limited(1024 * 1024));
        try std.testing.expect(hashMatches(source, file.patchedSha256));
    }
    const last = parsed.value.files[parsed.value.files.len - 1];
    const target = try std.fs.path.join(a, &.{ root, last.path });
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = target, .data = "unexpected compiler source\n" });
    try std.testing.expectError(error.ZigTlsSourceDrift, apply(io, a, root));
}
