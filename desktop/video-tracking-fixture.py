import sys
from pathlib import Path
import cv2
import numpy as np

folder=Path(sys.argv[1]);folder.mkdir(parents=True,exist_ok=True)
for name, total, cut in [('cut.avi',70,30),('long.avi',1500,None)]:
    writer=cv2.VideoWriter(str(folder/name),cv2.VideoWriter_fourcc(*'MJPG'),10,(260,160))
    assert writer.isOpened()
    for index in range(total):
        rng=np.random.default_rng(42 if cut is None or index<cut else 63)
        texture=rng.integers(20,240,(60,70,3),dtype=np.uint8)
        image=np.full((160,260,3),15 if cut is None or index<cut else 170,np.uint8)
        x=30+index if cut is not None and index<cut else 140+index-cut if cut is not None else 30+int(45*(1-np.cos(index/45)))
        image[40:100,x:x+70]=texture
        writer.write(image)
    writer.release()
print(folder)
