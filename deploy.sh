#!/bin/bash
git push
ssh clockout "source ~/.nvm/nvm.sh && cd ~/clockout && git pull && pm2 restart clockout"
