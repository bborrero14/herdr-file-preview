/* sample.c — C highlighting fixture */
#include <stdio.h>
#include <string.h>

#define LIMIT 1000000

static int is_binary(const char *buf, size_t n) {
    return memchr(buf, '\0', n) != NULL;
}

int main(int argc, char **argv) {
    char buf[4096];
    FILE *f = fopen(argc > 1 ? argv[1] : "sample.c", "rb");
    if (!f) { perror("fopen"); return 1; }
    size_t n = fread(buf, 1, sizeof buf, f);
    printf("%zu bytes, binary=%d\n", n, is_binary(buf, n));
    fclose(f);
    return 0;
}
