"""The key pair that seals users' broker keys on the Market Ripple platform.

The web server encrypts every broker key a user adds with the PUBLIC key (RSA-OAEP-SHA256 wrapping a fresh
AES-256-GCM key per secret), so what reaches the database is unreadable. Only the sync worker, which holds the
PRIVATE key, can open it. The private key is written straight into the private keys folder (the same one as
the owner's own broker keys) and is never printed.

    python -m predictor.platform_keys init     # make the pair once; prints the public key for the web app
    python -m predictor.platform_keys public   # print the public key again
"""
import base64
import json
import os
import sys

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .brokers import SECRETS

PRIVATE = SECRETS / "connections_private.pem"


def _public_b64(priv):
    der = priv.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return base64.b64encode(der).decode()


def load_private():
    return serialization.load_pem_private_key(PRIVATE.read_bytes(), password=None)


def unseal(sealed, priv=None):
    """Open one sealed secret made by the web app (web/src/lib/seal.ts): returns the dict of fields."""
    priv = priv or load_private()
    s = json.loads(sealed)
    if s.get("v") != 1:
        raise ValueError("unknown sealed format")
    key = priv.decrypt(base64.b64decode(s["k"]), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    plain = AESGCM(key).decrypt(base64.b64decode(s["iv"]), base64.b64decode(s["ct"]) + base64.b64decode(s["tag"]), None)
    return json.loads(plain)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv[0] if argv else "public"
    if cmd == "init":
        if PRIVATE.exists():
            print("A key pair already exists; not replacing it (that would make every stored key unreadable).")
        else:
            SECRETS.mkdir(exist_ok=True)
            priv = rsa.generate_private_key(public_exponent=65537, key_size=3072)
            pem = priv.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
            fd = os.open(PRIVATE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(pem)
            print("Private key written to the private keys folder (never printed).")
    priv = load_private()
    print("CONNECTIONS_PUBLIC_KEY=" + _public_b64(priv))
    return 0


if __name__ == "__main__":
    sys.exit(main())
