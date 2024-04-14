import fs from 'fs';
import mime from 'mime';
import { NextApiRequest, NextApiResponse } from 'next';
import nullthrows from 'nullthrows';
import path from 'path';

import {
  getLatestUpdateBundlePathForRuntimeVersionAsync,
  getMetadataAsync,
} from '../../common/helpers';

export default async function assetsEndpoint(req: NextApiRequest, res: NextApiResponse) {
  const { asset: assetName, runtimeVersion, platform } = req.query;

  console.error('assets', assetName, runtimeVersion, platform, process.env.HOSTNAME);

  if (!assetName || typeof assetName !== 'string') {
    res.statusCode = 400;
    res.json({ error: 'No asset name provided.' });
    console.error('assets error1');
    return;
  }

  if (platform !== 'ios' && platform !== 'android') {
    res.statusCode = 400;
    res.json({ error: 'No platform provided. Expected "ios" or "android".' });
    console.error('assets error2');
    return;
  }

  if (!runtimeVersion || typeof runtimeVersion !== 'string') {
    res.statusCode = 400;
    res.json({ error: 'No runtimeVersion provided.' });
    console.error('assets error3');
    return;
  }

  let updateBundlePath: string;
  try {
    updateBundlePath = await getLatestUpdateBundlePathForRuntimeVersionAsync(runtimeVersion);
  } catch (error: any) {
    res.statusCode = 404;
    res.json({
      error: error.message,
    });
    console.error('assets error4', error?.message);
    return;
  }

  console.error('updateBundlePath', updateBundlePath);

  const { metadataJson } = await getMetadataAsync({
    updateBundlePath,
    runtimeVersion,
  });

  const assetPath = path.resolve(assetName);
  const assetMetadata = metadataJson.fileMetadata[platform].assets.find(
    (asset: any) => asset.path === assetName.replace(`${updateBundlePath}/`, '')
  );
  const isLaunchAsset =
    metadataJson.fileMetadata[platform].bundle === assetName.replace(`${updateBundlePath}/`, '');

  if (!fs.existsSync(assetPath)) {
    res.statusCode = 404;
    res.json({ error: `Asset "${assetName}" does not exist.` });
    console.error('assets error5', assetName);
    return;
  }

  try {
    const asset = fs.readFileSync(assetPath, null);

    res.statusCode = 200;
    res.setHeader(
      'content-type',
      isLaunchAsset ? 'application/javascript' : nullthrows(mime.getType(assetMetadata.ext))
    );
    res.end(asset);
  } catch (error) {
    console.error('assets error6', error);
    console.log(error);
    res.statusCode = 500;
    res.json({ error });
  }

  console.error('assets success', assetPath);
}
export const config = {
  api: {
    responseLimit: false,
  },
}