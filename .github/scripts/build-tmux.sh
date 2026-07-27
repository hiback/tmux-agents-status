#!/bin/sh
# Build a pinned tmux release into a prefix so CI can run the advertised floor.
set -eu

version=$1
prefix=$2

work=$(mktemp -d)
trap 'rm -rf "$work"' 0
trap 'exit 1' 1 2 3 15

curl -fsSL \
	"https://github.com/tmux/tmux/releases/download/$version/tmux-$version.tar.gz" \
	-o "$work/tmux.tar.gz"
tar -xzf "$work/tmux.tar.gz" -C "$work"

cd "$work/tmux-$version"
# tmux 3.0 predates the C99-by-default toolchains CI now ships.
./configure --prefix="$prefix" CFLAGS='-std=gnu99 -Wno-error'
make -j"$(getconf _NPROCESSORS_ONLN)"
make install
