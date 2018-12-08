// Copyright 2017-2018 @polkadot/trie-db authors & contributors
// This software may be modified and distributed under the terms
// of the Apache-2.0 license. See the LICENSE file for details.

import { TxDb, ProgressCb } from '@polkadot/db/types';
import { Codec } from '@polkadot/trie-codec/types';
import { TrieDb, Node, NodeBranch, NodeEncodedOrEmpty, NodeKv, NodeNotEmpty, NodeType } from './types';

import substrateCodec from '@polkadot/trie-codec/index';
import { decodeNibbles, encodeNibbles, extractNodeKey } from '@polkadot/trie-codec/nibbles';
import { isNull, logger , u8aConcat, u8aToHex } from '@polkadot/util/index';

import { isBranchNode, isEmptyNode, isExtensionNode, isKvNode, isLeafNode } from './util/is';
import { keyEquals, keyStartsWith, computeExtensionKey, computeLeafKey, consumeCommonPrefix } from './util/key';
import { getNodeType, decodeNode, encodeNode } from './util/node';
import constants, { Constants } from './constants';

const l = logger('trie/db');

/**
 * # @polkadot/common/trie-db
 *
 * ## Overview
 *
 * @name Trie
 * @summary Re-implementation of a Patricia Trie
 * @example See [Polkadot-JS Common Trie-DB Examples](https://polkadot.js.org/api/common/examples/trie-db/)
 */
export default class Impl {
  readonly db: TxDb;
  protected codec: Codec;
  protected constants: Constants;
  protected txRoot: Uint8Array;
  protected rootHash: Uint8Array;

  constructor (db: TxDb, rootHash?: Uint8Array, codec: Codec = substrateCodec) {
    this.db = db;
    this.codec = codec;
    this.constants = constants(codec);
    this.rootHash = rootHash || this.constants.EMPTY_HASH;
    this.txRoot = this.rootHash;

    l.log(`Created with ${codec.type} codec, root ${u8aToHex(this.rootHash, 64)}`);
  }

  protected createCheckpoint (): Uint8Array {
    this.txRoot = this.rootHash;

    return this.txRoot;
  }

  protected commitCheckpoint (): Uint8Array {
    return this.rootHash;
  }

  protected revertCheckpoint (): Uint8Array {
    this.rootHash = this.txRoot;

    return this.rootHash;
  }

  protected _snapshot (dest: TrieDb, fn: ProgressCb, root: Uint8Array, keys: number, percent: number, depth: number): number {
    // l.debug(() => ['snapshot', { root }]);

    const node = this._getNode(root);

    if (isNull(node)) {
      return keys;
    }

    keys++;
    dest.db.put(root, encodeNode(this.codec, node));
    fn({ keys, percent });

    node.forEach((u8a) => {
      if (u8a && u8a.length === 32) {
        keys = this._snapshot(dest, fn, u8a, keys, percent, depth + 1);
      }

      percent += (100 / node.length) / Math.pow(16, depth);
    });

    return keys;
  }

  protected _getNode (hash: Uint8Array | null): Node {
    // l.debug(() => ['_getNode', { hash }]);

    if (!hash || hash.length === 0 || keyEquals(hash, this.constants.EMPTY_HASH)) {
      return null;
    } else if (hash.length < 32) {
      return decodeNode(this.codec, hash);
    }

    return decodeNode(this.codec, this.db.get(hash));
  }

  protected _del (node: Node, trieKey: Uint8Array): Node {
    // l.debug(() => ['_del', { node, trieKey }]);

    if (isEmptyNode(node)) {
      return null;
    } else if (isBranchNode(node)) {
      return this._delBranchNode(node, trieKey);
    } else if (isKvNode(node)) {
      return this._delKvNode(node, trieKey);
    }

    throw new Error('Unreachable');
  }

  protected _delBranchNode (node: NodeBranch, trieKey: Uint8Array): Node {
    // l.debug(() => ['_delBranchNode', { node, trieKey }]);

    if (trieKey.length === 0) {
      node[node.length - 1] = null;

      return this._normaliseBranchNode(node);
    }

    const nodeToDelete = this._getNode(node[trieKey[0]]);
    const subNode = this._del(nodeToDelete, trieKey.subarray(1));
    const encodedSubNode = this._persistNode(subNode);

    if (keyEquals(encodedSubNode, node[trieKey[0]])) {
      return node;
    }

    node[trieKey[0]] = encodedSubNode;

    if (isNull(encodedSubNode)) {
      return this._normaliseBranchNode(node);
    }

    return node;
  }

  protected _delKvNode (node: NodeNotEmpty, trieKey: Uint8Array): Node {
    // l.debug(() => ['_delKvNode', { node, trieKey }]);

    const currentKey = extractNodeKey(node);
    const nodeType = getNodeType(node);

    if (!keyStartsWith(trieKey, currentKey)) {
      return node;
    }

    if (nodeType === NodeType.LEAF) {
      return keyEquals(trieKey, currentKey)
        ? null
        : node;
    }

    const subKey = trieKey.subarray(currentKey.length);
    const subNode = this._getNode(node[1]);
    const newSub = this._del(subNode, subKey);
    const encodedNewSub = this._persistNode(newSub);

    if (keyEquals(encodedNewSub, node[1])) {
      return node;
    } else if (isNull(newSub)) {
      return null;
    }

    if (isKvNode(newSub)) {
      const subNibbles = decodeNibbles(newSub[0]);
      const newKey = u8aConcat(currentKey, subNibbles);

      return [encodeNibbles(newKey), newSub[1]];
    } else if (isBranchNode(newSub)) {
      return [encodeNibbles(currentKey), encodedNewSub];
    }

    throw new Error('Unreachable');
  }

  protected _get (node: Node, trieKey: Uint8Array): NodeEncodedOrEmpty {
    // l.debug(() => ['_get', { node, trieKey }]);

    if (isEmptyNode(node)) {
      return null;
    } else if (isBranchNode(node)) {
      return this._getBranchNode(node, trieKey);
    } else if (isKvNode(node)) {
      return this._getKvNode(node, trieKey);
    }

    throw new Error('Invalid NodeType');
  }

  protected _getBranchNode (node: NodeBranch, trieKey: Uint8Array): NodeEncodedOrEmpty {
    // l.debug(() => ['_getBranchNode', { node, trieKey }]);

    if (trieKey.length === 0) {
      return node[16];
    }

    const subNode = this._getNode(node[trieKey[0]]);

    return this._get(subNode, trieKey.subarray(1));
  }

  protected _getKvNode (node: NodeKv, trieKey: Uint8Array): NodeEncodedOrEmpty {
    // l.debug(() => ['_getKvNode', { node, trieKey }]);

    const currentKey = extractNodeKey(node);
    const nodeType = getNodeType(node);

    // l.debug(() => [{ currentKey, trieKey, nodeType }]);

    if (nodeType === NodeType.LEAF) {
      if (keyEquals(trieKey, currentKey)) {
        return node[1];
      }

      return null;
    } else if (nodeType === NodeType.EXTENSION) {
      if (keyStartsWith(trieKey, currentKey)) {
        const subNode = this._getNode(node[1]);

        return this._get(subNode, trieKey.subarray(currentKey ? currentKey.length : 0));
      }

      return null;
    }

    throw new Error('Unreachable');
  }

  protected _nodeToDbMapping (node: Node): NodeNotEmpty {
    // l.debug(() => ['_nodeToDbMapping', { node }]);

    if (isEmptyNode(node)) {
      return [null, null];
    }

    const encoded = encodeNode(this.codec, node);

    if (encoded.length < 32) {
      // FIXME typings...
      // @ts-ignore Ok, this is not correct - this comes back as an embedded node, which mean that our definitions here are completely wrong (or what we think it is, does not align with what it should be as per the spec and implementation)
      return [node, null];
    }

    return [this.codec.hashing(encoded), encoded];
  }

  protected _normaliseBranchNode (node: NodeNotEmpty): Node {
    // l.debug(() => ['_normaliseBranchNode', { node }]);

    const mapped = node
      .map((value, index) => ({ index, value }))
      .filter(({ value }) => !!value && value.length !== 0);

    if (mapped.length >= 2) {
      return node;
    }

    if (node[16]) {
      return [computeLeafKey(new Uint8Array()), node[16]];
    }

    const [{ index, value }] = mapped;
    const subNode = this._getNode(value);

    if (isBranchNode(subNode)) {
      return [encodeNibbles(new Uint8Array([index])), this._persistNode(subNode)];
    } else if (isKvNode(subNode)) {
      const subNibbles = decodeNibbles(subNode[0]);
      const newKey = u8aConcat(new Uint8Array([index]), subNibbles);

      return [encodeNibbles(newKey), subNode[1]];
    }

    throw new Error('Unreachable');
  }

  protected _persistNode (node: Node): NodeEncodedOrEmpty {
    const [key, value] = this._nodeToDbMapping(node);

    // l.debug(() => ['_persistNode', { node, key, value }]);

    if (value) {
      this.db.put(key as Uint8Array, value);
    }

    return key;
  }

  protected _put (node: Node, trieKey: Uint8Array, value: Uint8Array): NodeNotEmpty {
    // l.debug(() => ['_put', { node, trieKey, value }]);

    if (isEmptyNode(node)) {
      return [
        computeLeafKey(trieKey),
        value
      ];
    } else if (isKvNode(node)) {
      return this._putKvNode(node, trieKey, value);
    } else if (isBranchNode(node)) {
      return this._putBranchNode(node, trieKey, value);
    }

    throw new Error('Unreachable');
  }

  protected _putBranchNode (node: NodeBranch, trieKey: Uint8Array, value: Uint8Array): NodeNotEmpty {
    // l.debug(() => ['_putBranchNode', { node, trieKey, value }]);

    if (trieKey && trieKey.length) {
      const subNode = this._getNode(node[trieKey[0]]);
      const newNode = this._put(subNode, trieKey.subarray(1), value);

      node[trieKey[0]] = this._persistNode(newNode);
    } else {
      node[node.length - 1] = value;
    }

    return node;
  }

  protected _putKvNode (node: NodeKv, trieKey: Uint8Array, value: Uint8Array): NodeNotEmpty {
    // l.debug(() => ['_putKvNode', { node, trieKey, value }]);

    const currentKey = extractNodeKey(node);
    const [commonPrefix, currentRemainder, trieRemainder] = consumeCommonPrefix(currentKey, trieKey);
    const isExtension = isExtensionNode(node);
    const isLeaf = isLeafNode(node);
    let newNode: NodeNotEmpty;

    // l.debug(() => ['_putKvNode', { currentKey, commonPrefix, currentRemainder, trieRemainder }]);

    if (currentRemainder.length === 0 && trieRemainder.length === 0) {
      if (isLeaf) {
        return [
          node[0],
          value
        ];
      }

      const subNode = this._getNode(node[1]);

      newNode = this._put(subNode, trieRemainder, value);
    } else if (currentRemainder.length === 0) {
      if (isExtension) {
        const subNode = this._getNode(node[1]);

        newNode = this._put(subNode, trieRemainder, value);
      } else {
        const subPosition = trieRemainder[0];
        const subKey = computeLeafKey(trieRemainder.subarray(1));
        const subNode: NodeKv = [subKey, value];

        newNode = [
          null, null, null, null, null, null, null, null,
          null, null, null, null, null, null, null, null,
          node[1]
        ];
        newNode[subPosition] = this._persistNode(subNode);
      }
    } else {
      newNode = [
        null, null, null, null, null, null, null, null,
        null, null, null, null, null, null, null, null,
        null
      ];

      if (currentRemainder.length === 1 && isExtension) {
        newNode[currentRemainder[0]] = node[1];
      } else {
        const computedKey = isExtension
          ? computeExtensionKey(currentRemainder.subarray(1))
          : computeLeafKey(currentRemainder.subarray(1));

        newNode[currentRemainder[0]] = this._persistNode([
          computedKey,
          node[1]
        ]);
      }

      if (trieRemainder.length) {
        newNode[trieRemainder[0]] = this._persistNode([
          computeLeafKey(trieRemainder.subarray(1)),
          value
        ]);
      } else {
        newNode[16] = value;
      }
    }

    // l.debug(() => ['newNode', newNode]);

    if (commonPrefix.length) {
      return [
        computeExtensionKey(commonPrefix),
        this._persistNode(newNode)
      ];
    }

    return newNode;
  }

  protected _setRootNode (node: Node): void {
    // l.debug(() => ['_setRootNode', { node }]);

    if (isEmptyNode(node)) {
      this.rootHash = this.constants.EMPTY_HASH;
    } else {
      const encoded = encodeNode(this.codec, node);
      const rootHash = this.codec.hashing(encoded);

      // l.debug(() => ['_setRootNode', { encoded, rootHash }]);

      this.db.put(rootHash, encoded);

      this.rootHash = rootHash;
    }
  }
}
