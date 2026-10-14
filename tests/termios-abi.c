#define _XOPEN_SOURCE 600
#include <fcntl.h>
#include <stddef.h>
#include <stdlib.h>
#include <termios.h>
#include <unistd.h>

/* Use the target libc headers, independently of Zig's termios declaration. */
const size_t *hutch_test_termios_abi(void) {
    static const size_t layout[] = {
        sizeof(struct termios),
        _Alignof(struct termios),
        offsetof(struct termios, c_iflag),
        offsetof(struct termios, c_oflag),
        offsetof(struct termios, c_cflag),
        offsetof(struct termios, c_lflag),
        offsetof(struct termios, c_line),
        offsetof(struct termios, c_cc),
        sizeof(((struct termios *)0)->c_cc),
        offsetof(struct termios, c_ispeed),
        offsetof(struct termios, c_ospeed),
    };
    return layout;
}

/* A private PTY exercises libc without depending on the test runner's stdin. */
int hutch_test_open_terminal(int *master) {
    *master = posix_openpt(O_RDWR | O_NOCTTY);
    if (*master < 0) return -1;
    if (grantpt(*master) == 0 && unlockpt(*master) == 0) {
        char *name = ptsname(*master);
        if (name) {
            int slave = open(name, O_RDWR | O_NOCTTY);
            if (slave >= 0) return slave;
        }
    }
    close(*master);
    *master = -1;
    return -1;
}

void hutch_test_close_terminal(int fd) {
    close(fd);
}
