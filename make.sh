#!/bin/sh

cp buildscript/makexpi.sh ./
./makexpi.sh -n only-minor-update -o
rm ./makexpi.sh

