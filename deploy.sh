#!/bin/bash
git push
ssh clockout "cd ~/clockout && git pull && pm2 restart clockout"
